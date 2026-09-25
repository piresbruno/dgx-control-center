/** REST client for the node directory (registered nodes). */
import { apiGet, apiPost } from "./client.js";

export type NodeKind = "spark" | "gpu-host" | "nas";
export type NodeRole = "head" | "worker" | "standalone";

/** Mirrors the server's nodeRecordSchema (`config/nodes.json`). */
export interface NodeRecord {
  id: string;
  name: string;
  kind: NodeKind;
  role: NodeRole;
  llmPorts: number[];
  /** Agent metric cadences per domain, ms. */
  intervals: Record<string, number>;
  lanIp?: string;
  cx7Ip?: string;
  sshUser?: string;
  modelctlEnabled: boolean;
  createdAt: number;
}

export interface InstallOutcome {
  ok: boolean;
  mode: "system" | "user";
  reason: string | null;
  helloSeen: boolean;
}

export const listNodes = (): Promise<{ nodes: NodeRecord[] }> => apiGet("/api/nodes");
export const registerNode = (body: {
  id: string;
  name: string;
  kind: NodeKind;
  role: NodeRole;
  lanIp?: string;
  sshUser?: string;
}): Promise<NodeRecord> => apiPost("/api/nodes", body);
export const installAgent = (id: string): Promise<InstallOutcome> => apiPost(`/api/nodes/${id}/install-agent`);
