import { describe, expect, it } from "vitest";
import { openDb } from "../stores/db.js";
import { collectConfig, importConfig, createBackup, listBackups, CONFIG_ALLOWLIST } from "./backup.js";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function configDir() {
  return mkdtemp(join(tmpdir(), "cc-backup-"));
}

describe("config export/import", () => {
  it("collects only existing allowlisted files as parsed JSON", async () => {
    const dir = await configDir();
    await writeFile(join(dir, "nodes.json"), JSON.stringify([{ id: "dgx1", kind: "spark" }]));
    await writeFile(join(dir, "sneaky.sh"), "#!/bin/sh\nrm -rf /");
    const manifest = collectConfig(dir, new Date("2026-09-24T00:00:00Z"));
    expect(manifest.kind).toBe("controlcenter-config-export");
    expect(manifest.files["nodes.json"]).toEqual([{ id: "dgx1", kind: "spark" }]);
    expect((manifest.files as Record<string, unknown>)["sneaky.sh"]).toBeUndefined();
    expect(manifest.files["clients.json"]).toBeUndefined(); // absent files omitted
  });

  it("round-trips an import and rejects foreign files/kinds", async () => {
    const dir = await configDir();
    const manifest = collectConfig(dir, new Date("2026-09-24T00:00:00Z"));
    const files = manifest.files as Record<string, unknown>;
    files["nodes.json"] = [{ id: "dgx9", kind: "spark" }];
    files["../escape.json"] = { evil: true };

    const bad = importConfig(dir, { kind: "other", files: {} });
    expect(bad).toEqual({ error: "not a controlcenter-config-export manifest" });

    const res = importConfig(dir, manifest);
    expect(res).toEqual({ written: ["nodes.json"], skipped: ["../escape.json"], restartRequired: true });
    expect(JSON.parse(await readFile(join(dir, "nodes.json"), "utf8"))).toEqual([{ id: "dgx9", kind: "spark" }]);
    // Foreign name was never written.
    await expect(stat(join(dir, "../escape.json"))).rejects.toThrow();
  });

  it("allows every canonical name and nothing else", () => {
    expect(CONFIG_ALLOWLIST).not.toContain("alert-webhooks.json.tmp");
    expect(CONFIG_ALLOWLIST).toContain("desired-state.json");
  });
});

describe("backups", () => {
  it("creates a consistent backup (checkpointed db + configs) and lists it", async () => {
    const dir = await configDir();
    const db = openDb(join(dir, "controlcenter.db"), 0);
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42)");
    await writeFile(join(dir, "nodes.json"), JSON.stringify([{ id: "dgx1" }]));

    const backup = createBackup(dir, db, new Date("2026-09-24T00:00:00Z"));
    expect(backup.files).toContain("nodes.json");
    expect(backup.dbBytes).toBeGreaterThan(0);

    // The copied db is a valid, readable SQLite file with the data.
    const copy = openDb(join(backup.dir, "controlcenter.db"), 0);
    expect((copy.prepare("SELECT x FROM t").get() as { x: number }).x).toBe(42);
    copy.close();

    const listed = listBackups(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("2026-09-24T00-00-00-000Z");
    expect(listed[0]!.files).toContain("nodes.json");
  });

  it("lists nothing when no backups exist", async () => {
    expect(listBackups(await configDir())).toEqual([]);
  });
});
