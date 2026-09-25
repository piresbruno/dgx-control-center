/**
 * Single fetch helper for the dashboard's REST calls.
 *
 * This is the data seam: every page reads and writes through these
 * functions (or the domain clients in ../api/* that use them). Nothing in
 * web/ holds mock data — the only mock mechanism is the server's
 * `--fake-fleet` mode, which seeds the same routes/tables the real fleet
 * fills. Drop the flag and the identical UI is talking to real data.
 * See docs/DESIGN_SYSTEM.md.
 */

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const apiGet = <T>(url: string): Promise<T> => apiJson<T>(url);
export const apiPost = <T>(url: string, body?: unknown): Promise<T> =>
  apiJson<T>(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPatch = <T>(url: string, body?: unknown): Promise<T> =>
  apiJson<T>(url, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiPut = <T>(url: string, body?: unknown): Promise<T> =>
  apiJson<T>(url, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
export const apiDelete = <T>(url: string): Promise<T> => apiJson<T>(url, { method: "DELETE" });
