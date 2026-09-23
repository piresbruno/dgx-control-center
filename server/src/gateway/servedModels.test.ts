import { describe, expect, it } from "vitest";
import { rankTargets, resolveRoute, ServedModelsStore, type ServedModelTarget } from "./servedModels.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = (nodeId: string, port: number): ServedModelTarget => ({ nodeId, port });

describe("rankTargets", () => {
  const healthOf = (t: ServedModelTarget) =>
    t.nodeId === "dgx1" ? "healthy" : t.nodeId === "dgx2" ? "healthy" : t.nodeId === "dgx3" ? "down" : "unknown";

  it("orders healthy first, down last, stable within class", () => {
    const ranked = rankTargets([T("dgx3", 1), T("dgx9", 2), T("dgx1", 3), T("dgx2", 4)], healthOf);
    expect(ranked.map((t) => t.nodeId)).toEqual(["dgx1", "dgx2", "dgx9", "dgx3"]);
    expect(ranked[0]!.health).toBe("healthy");
  });

  it("round-robins within the healthy class via the counter", () => {
    const targets = [T("dgx1", 3), T("dgx2", 4)];
    expect(rankTargets(targets, healthOf, 0).map((t) => t.nodeId)).toEqual(["dgx1", "dgx2"]);
    expect(rankTargets(targets, healthOf, 1).map((t) => t.nodeId)).toEqual(["dgx2", "dgx1"]);
    expect(rankTargets(targets, healthOf, 2).map((t) => t.nodeId)).toEqual(["dgx1", "dgx2"]);
  });
});

describe("resolveRoute", () => {
  const configs = [
    {
      id: "sm-1",
      alias: "gpt-local",
      targets: [T("dgx1", 8888), T("dgx2", 8888)],
      onDemand: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "sm-2",
      alias: "spun-up",
      targets: [T("dgx3", 9999)],
      onDemand: { recipeId: "r1", idleStopS: 300 },
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const healthOf = (t: ServedModelTarget) => (t.nodeId === "dgx1" ? "healthy" : "down");

  it("returns the ranked chain healthy-first", () => {
    const r = resolveRoute(configs, "gpt-local", healthOf);
    expect(r).toMatchObject({ alias: "gpt-local", onDemand: false });
    if ("chain" in r) expect(r.chain.map((t) => t.nodeId)).toEqual(["dgx1", "dgx2"]);
  });

  it("unknown alias reports the live served-name list", () => {
    const r = resolveRoute(configs, "nope", healthOf);
    expect(r).toEqual({ error: "unknown-alias", servedNames: ["gpt-local", "spun-up"] });
  });

  it("keeps onDemand models routable with the flag set when all targets are down", () => {
    const r = resolveRoute(configs, "spun-up", healthOf);
    if ("chain" in r) {
      expect(r.onDemand).toBe(true);
      expect(r.chain).toHaveLength(1);
      expect(r.chain[0]!.health).toBe("down");
    } else throw new Error("expected route");
  });

  it("rejects alias-less configs with empty targets", () => {
    const r = resolveRoute([{ id: "x", alias: "empty", targets: [], onDemand: null, createdAt: 1, updatedAt: 1 }], "empty", healthOf);
    expect(r).toEqual({ error: "no-targets", alias: "empty" });
  });
});

describe("ServedModelsStore", () => {
  async function store() {
    const file = join(await mkdtemp(join(tmpdir(), "cc-sm-")), "served-models.json");
    return new ServedModelsStore({ filePath: file, now: () => 1_000 });
  }

  it("upserts with unique aliases and persists across reloads", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "cc-sm-")), "served-models.json");
    const s = new ServedModelsStore({ filePath: file, now: () => 1_000 });
    const m = s.upsert({ alias: "gpt-local", targets: [T("dgx1", 8888)] });
    expect(() => s.upsert({ alias: "gpt-local", targets: [] })).toThrow(/already served/);
    const updated = s.upsert({ id: m.id, alias: "gpt-local", targets: [T("dgx1", 8888), T("dgx2", 8888)] });
    expect(updated.targets).toHaveLength(2);
    expect(updated.createdAt).toBe(1_000);

    const reloaded = new ServedModelsStore({ filePath: file, now: () => 2_000 });
    expect(reloaded.byAlias("gpt-local")?.targets).toHaveLength(2);
    expect(reloaded.list()).toHaveLength(1);
  });

  it("removes records", async () => {
    const s = await store();
    const m = s.upsert({ alias: "a", targets: [] });
    expect(s.remove(m.id)).toBe(true);
    expect(s.get(m.id)).toBeNull();
    expect(s.remove(m.id)).toBe(false);
  });
});
