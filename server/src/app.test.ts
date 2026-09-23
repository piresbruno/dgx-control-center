import { describe, expect, it } from "vitest";
import { VERSION } from "@cc/shared";
import { buildApp } from "./app.js";
import { NodeDirectory } from "./nodeDirectory.js";
import { ModelctlService } from "./modelctl/service.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAYLOAD = JSON.stringify([
  { name: "GLM-5.3-Flash-EXL3", runtime: "vllm", repository: "zai-org/GLM-5.3-Flash-EXL3", bytes: 123 },
  { name: "Qwen3.6-35B", repository: "Qwen/Qwen3.6-35B", bytes: 0 },
]);

async function testDirectory(): Promise<NodeDirectory> {
  const dir = new NodeDirectory({ file: join(await mkdtemp(join(tmpdir(), "cc-")), "nodes.json") });
  await dir.load();
  return dir;
}

describe("model inventories (M2)", () => {
  it("GET /api/models serves the NAS inventory via modelctl", async () => {
    const modelctl = new ModelctlService({ runner: async () => PAYLOAD });
    const app = buildApp({ nodeDirectory: await testDirectory(), modelctl });
    const res = await app.inject({ method: "GET", url: "/api/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stale).toBe(false);
    expect(body.models[0]).toMatchObject({ name: "GLM-5.3-Flash-EXL3", bytes: 123 });
    await app.close();
  });

  it("GET /api/nodes/:id/models runs modelctl --local over the node SSH transport", async () => {
    const modelctl = new ModelctlService({ runner: async () => PAYLOAD });
    const seen: Array<{ host: string; user: string; args: string[] }> = [];
    const dir = await testDirectory();
    const app = buildApp({
      nodeDirectory: dir,
      modelctl,
      nodeInventoryRunner: async (host, user, args) => {
        seen.push({ host, user, args });
        return PAYLOAD;
      },
    });
    await dir.upsert({ id: "dgx1", name: "dgx-1", kind: "spark", role: "head", lanIp: "10.0.0.11", sshUser: "piresbruno" });

    const res = await app.inject({ method: "GET", url: "/api/nodes/dgx1/models" });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toHaveLength(2);
    expect(seen[0]).toMatchObject({ host: "10.0.0.11", user: "piresbruno" });
    await app.close();
  });

  it("returns 404 for unknown nodes and 400 when lanIp/sshUser are missing", async () => {
    const dir = await testDirectory();
    const app = buildApp({ nodeDirectory: dir, modelctl: new ModelctlService({ runner: async () => PAYLOAD }) });
    expect((await app.inject({ method: "GET", url: "/api/nodes/nope/models" })).statusCode).toBe(404);
    await dir.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone" });
    expect((await app.inject({ method: "GET", url: "/api/nodes/nas1/models" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/health", () => {
  it("returns ok with the shared version", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, name: "controlcenter", version: VERSION });
    expect(typeof body.time).toBe("string");
    await app.close();
  });
});
