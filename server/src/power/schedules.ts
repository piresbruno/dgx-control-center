/**
 * Clock schedules (M5): time-window profile overrides per node, evaluated in
 * the node's IANA timezone. While a window is active the schedule's profile
 * wins; outside windows the node's manual desired profile applies. Windows
 * may cross midnight (start > end wraps).
 */
import fs from "node:fs";
import { z } from "zod";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

const scheduleSchema = z.object({
  sparkId: z.string(),
  /** IANA timezone (validated on set). */
  tz: z.string().min(1).max(64),
  rules: z
    .array(
      z.object({
        profileId: z.string().min(1),
        start: HHMM,
        end: HHMM,
      }),
    )
    .max(10),
});
export type ClockSchedule = z.infer<typeof scheduleSchema>;

export const schedulesFileSchema = z.object({
  version: z.literal(1).default(1),
  schedules: z.array(scheduleSchema).default([]),
});

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local HH:MM in a timezone (pure via Intl; invalid tz → null). */
export function localTimeIn(tz: string, date: Date): string | null {
  if (!validTimezone(tz)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return parts; // "HH:MM"
}

/** Is `time` (HH:MM) inside [start, end]? Wraps midnight when start > end. */
export function inWindow(time: string, start: string, end: string): boolean {
  const t = time.split(":").map(Number);
  const s = start.split(":").map(Number);
  const e = end.split(":").map(Number);
  const mins = t[0]! * 60 + t[1]!;
  const sM = s[0]! * 60 + s[1]!;
  const eM = e[0]! * 60 + e[1]!;
  if (sM <= eM) return mins >= sM && mins < eM;
  return mins >= sM || mins < eM; // overnight window
}

/**
 * The schedule's active profile for `at`, or null when no window applies
 * (first matching rule wins — rules are ordered).
 */
export function activeProfile(schedule: ClockSchedule, at: Date): string | null {
  const local = localTimeIn(schedule.tz, at);
  if (local == null) return null;
  for (const rule of schedule.rules) {
    if (inWindow(local, rule.start, rule.end)) return rule.profileId;
  }
  return null;
}

export interface ScheduleStoreDeps {
  filePath: string;
  now?: () => number;
}

export class ScheduleStore {
  private data: z.infer<typeof schedulesFileSchema> = schedulesFileSchema.parse({});
  private readonly file: string;

  constructor(deps: ScheduleStoreDeps) {
    this.file = deps.filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      this.data = schedulesFileSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (err) {
      console.error("[clock-schedules] failed to load:", err instanceof Error ? err.message : err);
      this.data = schedulesFileSchema.parse({});
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[clock-schedules] failed to persist:", err instanceof Error ? err.message : err);
    }
  }

  list(): ClockSchedule[] {
    return [...this.data.schedules];
  }

  forNode(sparkId: string): ClockSchedule | null {
    return this.data.schedules.find((s) => s.sparkId === sparkId) ?? null;
  }

  set(sparkId: string, tz: string, rules: ClockSchedule["rules"]): ClockSchedule | null {
    if (!validTimezone(tz)) return null;
    const parsed = scheduleSchema.parse({ sparkId, tz, rules });
    this.data.schedules = this.data.schedules.filter((s) => s.sparkId !== sparkId);
    this.data.schedules.push(parsed);
    this.persist();
    return parsed;
  }

  remove(sparkId: string): boolean {
    const before = this.data.schedules.length;
    this.data.schedules = this.data.schedules.filter((s) => s.sparkId !== sparkId);
    if (this.data.schedules.length === before) return false;
    this.persist();
    return true;
  }
}
