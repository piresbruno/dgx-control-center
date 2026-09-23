import { z } from "zod";
import { atomicWriteJson, readJson } from "./util/atomicWrite.js";
import type { NodeRuntimeConfig } from "./agentHub.js";
import { profileById, resolveProfile } from "./power/profiles.js";

/**
 * Desired per-node state (F1a): the reconciler's source of truth, persisted
 * in `config/desired-state.json`. `clockProfileId` is stored now and applied
 * by the agent at M5; runtime config drifts are pushed as config-update.
 */
export const desiredNodeStateSchema = z.object({
  clockProfileId: z.string().nullable().default(null),
  intervals: z.record(z.string(), z.number().int().positive()).default({ cpu: 1000, gpu: 1000, memory: 5000, network: 5000, storage: 5000 }),
  llmPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  role: z.enum(["head", "worker", "standalone"]).default("standalone"),
});
export type DesiredNodeState = z.infer<typeof desiredNodeStateSchema>;

export const desiredStateFileSchema = z.object({
  version: z.literal(1).default(1),
  nodes: z.record(z.string(), desiredNodeStateSchema).default({}),
});
export type DesiredStateFile = z.infer<typeof desiredStateFileSchema>;

export interface DesiredStateStoreDeps {
  file: string;
}

export class DesiredStateStore {
  private state: DesiredStateFile = { version: 1, nodes: {} };
  private loaded = false;

  constructor(private readonly deps: DesiredStateStoreDeps) {}

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.deps.file, null);
    const parsed = desiredStateFileSchema.safeParse(raw ?? {});
    if (parsed.success) this.state = parsed.data;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) await this.load();
    await atomicWriteJson(this.deps.file, this.state);
  }

  get(nodeId: string): DesiredNodeState {
    return this.state.nodes[nodeId] ?? { clockProfileId: null, intervals: { cpu: 1000, gpu: 1000, memory: 5000, network: 5000, storage: 5000 }, llmPorts: [], role: "standalone" };
  }

  /** Merge-patch: partial update keeps sibling fields (per-key deep merge). */
  async patch(nodeId: string, patch: Partial<DesiredNodeState>): Promise<DesiredNodeState> {
    if (!this.loaded) await this.load();
    const current = this.get(nodeId);
    const next = desiredNodeStateSchema.parse({ ...current, ...patch });
    this.state.nodes[nodeId] = next;
    await this.persist();
    return next;
  }

  async remove(nodeId: string): Promise<void> {
    if (!this.loaded) await this.load();
    delete this.state.nodes[nodeId];
    await this.persist();
  }

  toRuntimeConfig(nodeId: string): NodeRuntimeConfig {
    const d = this.get(nodeId);
    const profile = d.clockProfileId ? profileById(d.clockProfileId) : null;
    const resolved = profile ? resolveProfile(profile, null) : null;
    return {
      intervals: d.intervals,
      llmPorts: d.llmPorts,
      role: d.role,
      clockProfileId: d.clockProfileId,
      clockCaps: resolved ? { gpuMaxMhz: resolved.gpuMaxMhz, cpuMaxMhz: resolved.cpuMaxMhz } : null,
    };
  }
}
