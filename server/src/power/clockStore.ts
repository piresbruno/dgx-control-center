/**
 * Desired clock profile per node (M5). JSON-file store keyed by sparkId;
 * boot reconcile and the agent's apply verbs read this — the desired state
 * survives dashboard restarts and node reboots re-apply it.
 */
import fs from "node:fs";
import { z } from "zod";
import { profileById } from "./profiles.js";

const entrySchema = z.object({
  sparkId: z.string(),
  profile: z.enum(["full", "eco", "quiet"]),
  updatedAt: z.number(),
  updatedBy: z.string().nullable().default(null),
});
export type ClockDesireRecord = z.infer<typeof entrySchema>;

export interface ClockStoreDeps {
  filePath: string;
  now?: () => number;
}

export class ClockProfileStore {
  private readonly desires = new Map<string, ClockDesireRecord>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(deps: ClockStoreDeps) {
    this.file = deps.filePath;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const d of raw.desires ?? []) {
        const parsed = entrySchema.safeParse(d);
        if (parsed.success) this.desires.set(parsed.data.sparkId, parsed.data);
      }
    } catch (err) {
      console.error("[clock-profiles] failed to load state:", err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const desires = [...this.desires.values()].sort((a, b) => a.sparkId.localeCompare(b.sparkId));
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, desires }, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[clock-profiles] failed to persist state:", err instanceof Error ? err.message : err);
    }
  }

  /** Desired profile id for a node (default "full" = uncapped). */
  desiredFor(sparkId: string): ClockDesireRecord {
    return this.desires.get(sparkId) ?? { sparkId, profile: "full", updatedAt: 0, updatedBy: null };
  }

  set(sparkId: string, profileId: string, updatedBy: string | null = null): ClockDesireRecord | null {
    const profile = profileById(profileId);
    if (!profile) return null;
    const rec: ClockDesireRecord = { sparkId, profile: profile.id, updatedAt: this.now(), updatedBy };
    this.desires.set(sparkId, rec);
    this.persist();
    return rec;
  }

  list(): ClockDesireRecord[] {
    return [...this.desires.values()];
  }

  clear(sparkId: string): boolean {
    if (!this.desires.delete(sparkId)) return false;
    this.persist();
    return true;
  }
}
