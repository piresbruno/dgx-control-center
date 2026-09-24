/**
 * System settings (M7): retention windows, capture toggle, CORS origins.
 * JSON store at config/settings.json; defaults are safe (capture off by
 * default per PLAN §8 — payloads are never stored in v1).
 */
import fs from "node:fs";
import { z } from "zod";

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  retention: z
    .object({
      /** Traces older than this are pruned (days). */
      tracesDays: z.number().int().min(1).max(365).default(7),
      /** Max alert events retained. */
      alertEventsMax: z.number().int().min(100).max(100_000).default(10_000),
      /** Max backups retained in config/backups. */
      backupsKeep: z.number().int().min(1).max(100).default(10),
    })
    .default({}),
  capture: z
    .object({
      /** Request payload capture (v1: off — metadata only). */
      payloads: z.boolean().default(false),
    })
    .default({}),
  /** Exact-origin allowlist for the browser WS/REST (empty = same-origin only). */
  corsOrigins: z.array(z.string()).max(20).default([]),
});
export type SystemSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: SystemSettings = settingsSchema.parse({});

export interface SettingsStoreDeps {
  filePath: string;
}

export class SettingsStore {
  private data: SystemSettings = DEFAULT_SETTINGS;
  private readonly file: string;

  constructor(deps: SettingsStoreDeps) {
    this.file = deps.filePath;
    try {
      if (fs.existsSync(this.file)) this.data = settingsSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (err) {
      console.error("[settings] failed to load:", err instanceof Error ? err.message : err);
      this.data = DEFAULT_SETTINGS;
    }
  }

  get(): SystemSettings {
    return this.data;
  }

  patch(
    patch: {
      retention?: Partial<SystemSettings["retention"]>;
      capture?: Partial<SystemSettings["capture"]>;
      corsOrigins?: string[];
    },
  ): SystemSettings {
    this.data = settingsSchema.parse({
      ...this.data,
      retention: { ...this.data.retention, ...(patch.retention ?? {}) },
      capture: { ...this.data.capture, ...(patch.capture ?? {}) },
      corsOrigins: patch.corsOrigins ?? this.data.corsOrigins,
    });
    this.persist();
    return this.data;
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[settings] failed to persist:", err instanceof Error ? err.message : err);
    }
  }
}
