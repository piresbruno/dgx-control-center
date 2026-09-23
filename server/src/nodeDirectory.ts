import { z } from "zod";
import { NODE_KINDS, NODE_ROLES } from "@cc/shared";
import { atomicWriteJson, readJson } from "./util/atomicWrite.js";

/** Registered node — kind gates spark-only features (clocks, UMA). */
export const nodeRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(1).max(80),
  kind: z.enum(NODE_KINDS),
  role: z.enum(NODE_ROLES),
  llmPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  /** Agent metric cadences per domain, ms. */
  intervals: z.record(z.string(), z.number().int().positive()).default({ system: 1000 }),
  lanIp: z.string().optional(),
  cx7Ip: z.string().optional(),
  sshUser: z.string().optional(),
  modelctlEnabled: z.boolean().default(false),
  createdAt: z.number().int().positive(),
});
export type NodeRecord = z.infer<typeof nodeRecordSchema>;

const upsertEnvelope = z.object({ id: z.string() });
const upsertPatch = nodeRecordSchema.partial();

export interface NodeDirectoryDeps {
  file: string;
  now?: () => number;
}

/** nodes.json registry — CRUD with atomic persistence and zod validation. */
export class NodeDirectory {
  private nodes = new Map<string, NodeRecord>();
  private loaded = false;

  constructor(private readonly deps: NodeDirectoryDeps) {}

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.deps.file, []);
    const list = z.array(nodeRecordSchema).safeParse(raw);
    if (list.success) {
      this.nodes = new Map(list.data.map((n) => [n.id, n]));
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.loaded) await this.load();
    await atomicWriteJson(this.deps.file, [...this.nodes.values()]);
  }

  list(): NodeRecord[] {
    return [...this.nodes.values()];
  }

  get(id: string): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  isKnown(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Create or replace. Bad shape ⇒ zod error; missing id ⇒ 400-shaped error. */
  async upsert(input: unknown): Promise<NodeRecord> {
    if (!this.loaded) await this.load();
    const { id } = upsertEnvelope.parse(input);
    const patch = upsertPatch.parse(input);
    const existing = this.nodes.get(id);
    const parsed = nodeRecordSchema.parse({
      createdAt: existing?.createdAt ?? (this.deps.now ?? Date.now)(),
      llmPorts: [],
      intervals: { system: 1000 },
      modelctlEnabled: false,
      ...existing,
      ...patch,
      id,
    });
    this.nodes.set(id, parsed);
    await this.persist();
    return parsed;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.nodes.has(id)) return false;
    this.nodes.delete(id);
    await this.persist();
    return true;
  }
}
