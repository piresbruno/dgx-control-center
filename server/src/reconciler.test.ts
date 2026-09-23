import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerToAgent } from "@cc/shared";
import { computeNodeState, Reconciler, type ReconcileInputs } from "./reconciler.js";
import { NodeDirectory } from "./nodeDirectory.js";
import { DesiredStateStore } from "./desiredState.js";

const BASE_FACTS: ReconcileInputs = {
  known: true,
  connected: true,
  everConnected: true,
  lastMetricsTs: 10_000,
  intervalMs: 1_000,
  now: 11_000,
  desiredConfig: { intervals: { system: 1_000 }, llmPorts: [8888], role: "head" },
  lastSentConfig: { intervals: { system: 1_000 }, llmPorts: [8888], role: "head" },
  applyingSince: null,
  staleMultiplier: 3,
};

describe("computeNodeState (pure)", () => {
  const cases: Array<[string, Partial<typeof BASE_FACTS>, string]> = [
    ["never connected → provisioning", { everConnected: false, connected: false }, "provisioning"],
    ["connected then dropped → offline", { connected: false }, "offline"],
    ["config apply in flight → reconciling", { applyingSince: 10_500 }, "reconciling"],
    ["desired != lastSent → drifted", { lastSentConfig: { intervals: { system: 1_000 }, llmPorts: [], role: "head" } }, "drifted"],
    ["no metrics ever → degraded", { lastMetricsTs: null }, "degraded"],
    ["metrics older than 3× cadence → degraded", { lastMetricsTs: 5_000 }, "degraded"],
    ["fresh metrics → consistent", {}, "consistent"],
    ["drift wins over staleness", { lastMetricsTs: 5_000, lastSentConfig: { intervals: { system: 1_000 }, llmPorts: [], role: "head" } }, "drifted"],
  ];
  it.each(cases)("%s", (_name, patch, expected) => {
    expect(computeNodeState({ ...BASE_FACTS, ...patch })).toBe(expected);
  });

  it("stale floor is 5 s regardless of cadence", () => {
    expect(
      computeNodeState({ ...BASE_FACTS, intervalMs: 100, lastMetricsTs: 5_500, staleMultiplier: 3 }),
    ).toBe("degraded");
    expect(
      computeNodeState({ ...BASE_FACTS, intervalMs: 100, lastMetricsTs: 6_500, staleMultiplier: 3 }),
    ).toBe("consistent");
  });
});

class StubTransport {
  connected = new Set<string>();
  sent: Array<{ id: string; msg: ServerToAgent }> = [];
  isConnected(id: string): boolean {
    return this.connected.has(id);
  }
  send(id: string, msg: ServerToAgent): boolean {
    this.sent.push({ id, msg });
    return true;
  }
}

async function makeStack() {
  const dir = await mkdtemp(join(tmpdir(), "cc-reconciler-"));
  const directory = new NodeDirectory({ file: join(dir, "nodes.json"), now: () => 1 });
  await directory.load();
  await directory.upsert({ id: "dgx1", name: "DGX1", kind: "spark", role: "head" });
  const desired = new DesiredStateStore({ file: join(dir, "desired-state.json") });
  await desired.load();
  await desired.patch("dgx1", { role: "head", llmPorts: [8888] });
  const transport = new StubTransport();
  const stateChanges: Array<[string, string, string]> = [];
  const reconciler = new Reconciler({
    directory,
    desired,
    registry: transport,
    now: () => 11_000,
    onStateChange: (id, from, to) => stateChanges.push([id, from, to]),
  });
  return { directory, desired, transport, reconciler, stateChanges, dir };
}

describe("Reconciler", () => {
  it("seeds first contact with desired config and reports degraded until metrics flow", async () => {
    const stack = await makeStack();
    stack.transport.connected.add("dgx1");
    const states = stack.reconciler.tick();
    expect(states.get("dgx1")).toBe("degraded"); // connected, but no metrics yet
    const seed = stack.transport.sent.find((s) => s.id === "dgx1" && s.msg.type === "config-update");
    expect(seed).toBeDefined();

    stack.reconciler.observeMessage("dgx1", { type: "metrics" });
    expect(stack.reconciler.tick().get("dgx1")).toBe("consistent");
    expect(stack.stateChanges).toContainEqual(["dgx1", "degraded", "consistent"]);
  });

  it("pushes config-update on desired-state drift, reconciling until metrics confirm", async () => {
    const stack = await makeStack();
    stack.transport.connected.add("dgx1");
    stack.reconciler.tick();
    stack.reconciler.observeMessage("dgx1", { type: "metrics" });
    stack.reconciler.tick();
    expect(stack.reconciler.stateOf("dgx1")).toBe("consistent");

    await stack.desired.patch("dgx1", { llmPorts: [8888, 8889] });
    expect(stack.reconciler.tick().get("dgx1")).toBe("reconciling");
    const update = stack.transport.sent.filter((s) => s.msg.type === "config-update").at(-1);
    expect(update?.msg).toMatchObject({ type: "config-update", config: { llmPorts: [8888, 8889] } });

    stack.reconciler.observeMessage("dgx1", { type: "metrics" });
    expect(stack.reconciler.tick().get("dgx1")).toBe("consistent");
  });

  it("tracks offline after a connected node drops", async () => {
    const stack = await makeStack();
    stack.transport.connected.add("dgx1");
    stack.reconciler.tick();
    stack.transport.connected.delete("dgx1");
    expect(stack.reconciler.tick().get("dgx1")).toBe("offline");
  });

  it("persists desired state and node records across store reloads", async () => {
    const stack = await makeStack();
    const rawNodes = JSON.parse(await readFile(join(stack.dir, "nodes.json"), "utf8"));
    expect(rawNodes[0]).toMatchObject({ id: "dgx1", role: "head" });
    const rawDesired = JSON.parse(await readFile(join(stack.dir, "desired-state.json"), "utf8"));
    expect(rawDesired.nodes.dgx1).toMatchObject({ role: "head", llmPorts: [8888] });

    const reloadedDesired = new DesiredStateStore({ file: join(stack.dir, "desired-state.json") });
    await reloadedDesired.load();
    expect(reloadedDesired.get("dgx1").llmPorts).toEqual([8888]);
  });
});
