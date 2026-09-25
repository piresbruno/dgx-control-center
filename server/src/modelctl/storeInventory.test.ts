import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentToServer, ServerToAgent } from "@cc/shared";
import { NodeDirectory } from "../nodeDirectory.js";
import { JobsManager } from "../jobs/jobsManager.js";
import { createStoreInventoryRunner } from "./storeInventory.js";
import type { ModelctlRunner } from "./service.js";

const PAYLOAD = JSON.stringify([{ name: "GLM-5.3-Flash-EXL3", repository: "zai-org/GLM-5.3-Flash-EXL3", bytes: 1 }]);

interface Harness {
  runner: ModelctlRunner;
  sent: ServerToAgent[];
  jobs: JobsManager;
  setConnected: (id: string, connected: boolean) => void;
}

async function harness(nodes: Array<{ id: string; kind: "spark" | "nas" }>): Promise<Harness> {
  const file = join(await mkdtemp(join(tmpdir(), "cc-storeinv-")), "nodes.json");
  const directory = new NodeDirectory({ file });
  for (const n of nodes) {
    await directory.upsert({ id: n.id, name: n.id, kind: n.kind, role: n.kind === "nas" ? "standalone" : "head" });
  }
  const connected = new Set<string>(nodes.map((n) => n.id));
  const sent: ServerToAgent[] = [];
  const jobs = new JobsManager({
    send: (_id, msg) => {
      sent.push(msg);
      return true;
    },
    isConnected: (id) => connected.has(id),
    genReqId: (() => {
      let n = 0;
      return () => `req-${++n}`;
    })(),
  });
  return {
    runner: createStoreInventoryRunner({ nodeDirectory: directory, jobs, isConnected: (id) => connected.has(id) }),
    sent,
    jobs,
    setConnected: (id, c) => (c ? connected.add(id) : connected.delete(id)),
  };
}

function finish(jobs: JobsManager, nodeId: string, reqId: string, exitCode: number, output: string): void {
  jobs.observeMessage(nodeId, { type: "job-out", reqId, stream: "out", chunk: output } as AgentToServer);
  jobs.observeMessage(nodeId, { type: "job-exit", reqId, code: exitCode, signal: null } as AgentToServer);
}

describe("storeInventory runner (ADR-0009)", () => {
  it("dispatches the store-list job to the kind:nas store owner when connected", async () => {
    const h = await harness([
      { id: "dgx1", kind: "spark" },
      { id: "nas1", kind: "nas" },
    ]);
    const pending = h.runner(["list", "--json"]);
    const run = h.sent[0]!;
    expect(run).toMatchObject({ type: "job-run", argv: ["modelctl", "list", "--json"] });
    const reqId = (run as { reqId: string }).reqId;
    finish(h.jobs, "nas1", reqId, 0, PAYLOAD);
    await expect(pending).resolves.toBe(PAYLOAD);
  });

  it("falls back to the first connected spark node in directory order", async () => {
    const h = await harness([
      { id: "dgx1", kind: "spark" },
      { id: "dgx2", kind: "spark" },
    ]);
    h.setConnected("dgx1", false);
    const pending = h.runner(["list", "--json"]);
    const reqId = (h.sent[0] as { reqId: string }).reqId;
    finish(h.jobs, "dgx2", reqId, 0, PAYLOAD);
    await expect(pending).resolves.toBe(PAYLOAD);
    expect((h.sent[0] as { reqId: string }).reqId).toBe(reqId);
  });

  it("rejects with an actionable error when no node is connected", async () => {
    const h = await harness([{ id: "dgx1", kind: "spark" }]);
    h.setConnected("dgx1", false);
    await expect(h.runner(["list", "--json"])).rejects.toThrow(/no connected node/);
  });

  it("rejects non-zero job exits with the job output", async () => {
    const h = await harness([{ id: "dgx1", kind: "spark" }]);
    const pending = h.runner(["list", "--json"]);
    const reqId = (h.sent[0] as { reqId: string }).reqId;
    finish(h.jobs, "dgx1", reqId, 2, "modelctl: store root not configured");
    await expect(pending).rejects.toThrow(/store root not configured/);
  });

  it("rejects unexpected operations instead of dispatching them", async () => {
    const h = await harness([{ id: "dgx1", kind: "spark" }]);
    await expect(h.runner(["push", "--host", "h", "model"])).rejects.toThrow(/supports only/);
    expect(h.sent).toHaveLength(0);
  });
});
