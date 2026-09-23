import { describe, expect, it } from "vitest";
import { ClientsStore, generateClientKey, hashKey } from "./clients.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function store() {
  const file = join(await mkdtemp(join(tmpdir(), "cc-clients-")), "clients.json");
  return new ClientsStore({ filePath: file, now: () => 1_000 });
}

describe("keys", () => {
  it("generates prefixed keys and hashes deterministically", () => {
    const { key, keyHash, keyPrefix } = generateClientKey();
    expect(key).toMatch(/^cc-[0-9a-f]{48}$/);
    expect(keyHash).toBe(hashKey(key));
    expect(keyPrefix).toMatch(/^cc-[0-9a-f]{4}…$/);
    expect(key).not.toContain(keyHash);
  });
});

describe("ClientsStore", () => {
  it("creates, verifies, and bumps lastSeen", async () => {
    const s = await store();
    const { client, key } = s.create({ name: "showcase" });
    const seen = s.verify(key);
    expect(seen?.id).toBe(client.id);
    expect(s.verify(key)?.lastSeenAt).toBe(1_000);
    expect(s.verify("cc-wrong")).toBeNull();
    // Stored record never contains the full key.
    expect(JSON.stringify(s.get(client.id))).not.toContain(key.slice(8));
  });

  it("persists across reloads and verification still works", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-clients-")), "clients.json");
    const s = new ClientsStore({ filePath: file, now: () => 1_000 });
    const { key } = s.create({ name: "bench", scopes: ["glm"] });
    const reloaded = new ClientsStore({ filePath: file, now: () => 2_000 });
    expect(reloaded.verify(key)?.name).toBe("bench");
  });

  it("scopes: * grants all, explicit lists gate aliases", async () => {
    const s = await store();
    const wide = s.create({ name: "wide" }).client;
    const narrow = s.create({ name: "narrow", scopes: ["glm", "qwen"] }).client;
    expect(ClientsStore.canServe(wide, "anything")).toBe(true);
    expect(ClientsStore.canServe(narrow, "glm")).toBe(true);
    expect(ClientsStore.canServe(narrow, "other")).toBe(false);
  });

  it("revocation blocks verification; removal deletes", async () => {
    const s = await store();
    const { client, key } = s.create({ name: "tmp" });
    expect(s.revoke(client.id)).toBe(true);
    expect(s.verify(key)).toBeNull();
    expect(s.revoke(client.id)).toBe(false);
    expect(s.remove(client.id)).toBe(true);
    expect(s.get(client.id)).toBeNull();
  });
});
