/** REST client for the gateway plane: served-model router + per-client keys. */
import { apiDelete, apiGet, apiPost } from "./client.js";

export interface ServedTarget {
  nodeId: string;
  port: number;
  /** Upstream model id to send (defaults to the alias). */
  modelId?: string | null;
}

export interface ServedModel {
  id: string;
  /** Public model name clients request. */
  alias: string;
  targets: ServedTarget[];
  onDemand: { recipeId: string; idleStopS: number | null } | null;
  /** Vision-capable upstream: chat attachments route here. */
  vision: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ClientRow {
  id: string;
  name: string;
  keyPrefix: string;
  /** Allowed served-model aliases; ["*"] allows all. */
  scopes: string[];
  createdAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
}

export const listServedModels = (): Promise<{ models: ServedModel[] }> => apiGet("/api/gateway/served-models");
export const saveServedModel = (body: {
  id?: string;
  alias: string;
  targets: ServedTarget[];
  onDemand?: { recipeId: string; idleStopS?: number | null } | null;
  vision?: boolean;
}): Promise<ServedModel> => apiPost("/api/gateway/served-models", body);
export const deleteServedModel = (id: string): Promise<{ removed: boolean }> =>
  apiDelete(`/api/gateway/served-models/${id}`);

export const listClients = (): Promise<{ clients: ClientRow[] }> => apiGet("/api/gateway/clients");
export const createClient = (body: { name: string; scopes: string[] }): Promise<{ client: ClientRow; key: string }> =>
  apiPost("/api/gateway/clients", body);
export const revokeClient = (id: string): Promise<{ revoked: boolean }> =>
  apiPost(`/api/gateway/clients/${id}/revoke`);
export const removeClient = (id: string): Promise<{ removed: boolean }> => apiDelete(`/api/gateway/clients/${id}`);
