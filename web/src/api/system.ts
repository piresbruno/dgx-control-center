/** REST client for the system plane (settings, backups, maintenance, config import/export). */
import { apiGet, apiJson, apiPatch, apiPost } from "./client.js";

export interface SystemSettings {
  version: 1;
  retention: { tracesDays: number; alertEventsMax: number; backupsKeep: number };
  capture: { payloads: boolean };
  /** Exact-origin allowlist for the browser WS/REST (empty = same-origin only). */
  corsOrigins: string[];
}

export interface BackupRow {
  id: string;
  files: string[];
  dbBytes: number;
  createdAt: number;
}

export interface MaintenanceReport {
  ts: number;
  metricsPruned: Record<string, number>;
  tracesPruned: number;
  backupsDeleted: string[];
  checkpoint: "done";
}

export interface ImportResult {
  written: string[];
  skipped: string[];
  restartRequired: true;
}

export const getSettings = (): Promise<SystemSettings> => apiGet("/api/system/settings");
export const patchSettings = (patch: {
  retention?: Partial<SystemSettings["retention"]>;
  capture?: Partial<SystemSettings["capture"]>;
  corsOrigins?: string[];
}): Promise<SystemSettings> => apiPatch("/api/system/settings", patch);

export const listBackups = (): Promise<{ backups: BackupRow[] }> => apiGet("/api/system/backups");
export const createBackup = (): Promise<BackupRow> => apiPost("/api/system/backup");

export const runMaintenanceNow = (): Promise<MaintenanceReport> => apiPost("/api/system/maintenance");

/** Restores an export manifest (raw JSON text, forwarded verbatim); applied on next restart. */
export const importConfig = (manifestText: string): Promise<ImportResult> =>
  apiJson("/api/system/import", { method: "POST", body: manifestText });

/** Download URL for the config export manifest (plain <a href> link). */
export const configExportUrl = "/api/system/export";
