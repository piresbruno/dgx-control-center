import { jobArgv } from "../jobs/commands.js";
import type { JobsManager } from "../jobs/jobsManager.js";
import type { NodeDirectory } from "../nodeDirectory.js";
import type { ModelctlRunner } from "./service.js";

/**
 * Store inventory runner (ADR-0009): the model-store catalog executes on a
 * node that mounts the store, never on the dashboard host. Node selection is
 * deterministic: a registered `kind: "nas"` store owner first, else connected
 * spark/gpu-host nodes in directory order. No dashboard-local fallback.
 */

const STORE_LIST_ARGS = ["list", "--json"];

export interface StoreInventoryDeps {
  nodeDirectory: Pick<NodeDirectory, "list">;
  jobs: Pick<JobsManager, "dispatch" | "onFinished">;
  /** Agent-channel connectivity (JobsManager only carries it as a dep). */
  isConnected: (nodeId: string) => boolean;
  /** Job timeout; the manager kills the job server-side when exceeded. */
  timeoutMs?: number;
}

export function createStoreInventoryRunner(deps: StoreInventoryDeps): ModelctlRunner {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  return async (args) => {
    if (args.join(" ") !== STORE_LIST_ARGS.join(" ")) {
      throw new Error(`store inventory supports only: modelctl ${STORE_LIST_ARGS.join(" ")}`);
    }
    const nodes = deps.nodeDirectory.list();
    const nasFirst = [
      ...nodes.filter((n) => n.kind === "nas").map((n) => n.id),
      ...nodes.filter((n) => n.kind !== "nas").map((n) => n.id),
    ];
    const nodeId = nasFirst.find((id) => deps.isConnected(id));
    if (!nodeId) {
      throw new Error(
        "no connected node can run the store inventory — register the store owner (kind: nas) or connect a node with the store mounted and modelctl provisioned",
      );
    }
    const argv = jobArgv("modelctl-list-store", {});
    if (!argv) throw new Error("modelctl-list-store job kind is not registered");

    const dispatched = deps.jobs.dispatch(nodeId, "modelctl-list-store", argv, { timeoutMs });
    if ("error" in dispatched) {
      throw new Error(dispatched.error === "conflict" ? "store inventory job already running" : dispatched.error);
    }
    return await new Promise<string>((resolve, reject) => {
      const unsubscribe = deps.jobs.onFinished((job) => {
        if (job.reqId !== dispatched.reqId) return;
        unsubscribe();
        if (job.state === "done" && job.exitCode === 0) resolve(job.output);
        else reject(new Error(job.output.trim() || `modelctl exited ${job.exitCode ?? job.signal ?? "?"} on ${nodeId}`));
      });
    });
  };
}
