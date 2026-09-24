/**
 * Config export/import + backup tooling (M7).
 *
 * Export: one JSON manifest of every known config file (JSON-validated) —
 * secrets are already safe by design (client keys are stored hashed; tokens
 * live in env, never in config files).
 * Backup: timestamped directory under config/backups/ containing a WAL-
 * checkpointed SQLite snapshot (better-sqlite3 `backup()`) plus the config
 * files. Import: restore with a strict filename allowlist + JSON validation;
 * takes effect on next restart (202 + restartRequired).
 */
import fs from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";

/** Files the import may write (exact names — nothing else is trusted). */
export const CONFIG_ALLOWLIST = [
  "nodes.json",
  "desired-state.json",
  "serve-recipes.json",
  "serve-deployments.json",
  "served-models.json",
  "clients.json",
  "clock-profiles.json",
  "clock-schedules.json",
  "alert-rules.json",
  "alert-webhooks.json",
  "thermal-state.json",
] as const;

export type ConfigName = (typeof CONFIG_ALLOWLIST)[number];

export interface ExportManifest {
  version: 1;
  kind: "controlcenter-config-export";
  exportedAt: string;
  files: Partial<Record<ConfigName, unknown>>;
}

/** Collect all allowlisted config files that exist, JSON-parsed. */
export function collectConfig(configDir: string, now: Date = new Date()): ExportManifest {
  const files: ExportManifest["files"] = {};
  for (const name of CONFIG_ALLOWLIST) {
    const p = path.join(configDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      files[name] = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      console.error(`[backup] skipping unparsable ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  return { version: 1, kind: "controlcenter-config-export", exportedAt: now.toISOString(), files };
}

export type ImportResult =
  | { written: ConfigName[]; skipped: string[]; restartRequired: true }
  | { error: string };

/** Restore an export into the config dir (allowlisted names only, valid JSON). */
export function importConfig(configDir: string, manifest: unknown): ImportResult {
  if (typeof manifest !== "object" || manifest == null) return { error: "manifest must be an object" };
  const m = manifest as { kind?: string; files?: Record<string, unknown> };
  if (m.kind !== "controlcenter-config-export") return { error: "not a controlcenter-config-export manifest" };
  if (typeof m.files !== "object" || m.files == null) return { error: "manifest has no files" };
  const written: ConfigName[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(m.files)) {
    if (!(CONFIG_ALLOWLIST as readonly string[]).includes(name)) {
      skipped.push(name);
      continue;
    }
    written.push(name as ConfigName);
  }
  // Validate ALL payloads before writing anything (atomic-ish import).
  for (const name of written) {
    try {
      JSON.stringify(m.files[name]);
      JSON.parse(JSON.stringify(m.files[name]));
    } catch {
      return { error: `file ${name} is not JSON-serializable` };
    }
  }
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of written) {
    fs.writeFileSync(path.join(configDir, name), JSON.stringify(m.files[name], null, 2) + "\n", "utf8");
  }
  return { written, skipped, restartRequired: true };
}

export interface BackupRecord {
  id: string;
  dir: string;
  files: string[];
  dbBytes: number;
  createdAt: number;
}

/** Create a timestamped backup: checkpointed SQLite copy + config snapshot. */
export function createBackup(configDir: string, db: Database, now: Date = new Date()): BackupRecord {
  const id = now.toISOString().replace(/[:.]/g, "-");
  const dir = path.join(configDir, "backups", id);
  fs.mkdirSync(dir, { recursive: true });
  // Flush the WAL into the main db, then copy the file — consistent snapshot.
  db.pragma("wal_checkpoint(TRUNCATE)");
  const dbDest = path.join(dir, "controlcenter.db");
  fs.copyFileSync(path.join(configDir, path.basename(db.name)), dbDest);
  const files: string[] = [];
  for (const name of CONFIG_ALLOWLIST) {
    const p = path.join(configDir, name);
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, path.join(dir, name));
      files.push(name);
    }
  }
  const dbBytes = fs.statSync(dbDest).size;
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ id, createdAt: now.toISOString(), files, dbBytes }, null, 2) + "\n", "utf8");
  return { id, dir, files, dbBytes, createdAt: now.getTime() };
}

export function listBackups(configDir: string): BackupRecord[] {
  const root = path.join(configDir, "backups");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => {
      const dir = path.join(root, id);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "MANIFEST.json"), "utf8")) as {
          files: string[];
          dbBytes: number;
          createdAt: number;
        };
        return { id, dir, files: manifest.files, dbBytes: manifest.dbBytes, createdAt: manifest.createdAt };
      } catch {
        return null;
      }
    })
    .filter((b): b is BackupRecord => b != null)
    .sort((a, b) => b.createdAt - a.createdAt);
}
