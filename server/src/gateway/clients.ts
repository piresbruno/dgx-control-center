/**
 * Gateway clients and API keys (M4/F4): per-client hashed keys with model
 * scopes. The full key is shown exactly once at creation; only its SHA-256
 * hash and a display prefix are stored. Scopes allow-list served-model
 * aliases; "*" permits everything.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";

const KEY_PREFIX = "cc-";

export function generateClientKey(): { key: string; keyHash: string; keyPrefix: string } {
  const secret = crypto.randomBytes(24).toString("hex");
  const key = `${KEY_PREFIX}${secret}`;
  return { key, keyHash: hashKey(key), keyPrefix: `${KEY_PREFIX}${secret.slice(0, 4)}…` };
}

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

const clientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  keyHash: z.string().length(64),
  keyPrefix: z.string().min(3).max(20),
  /** Allowed served-model aliases; ["*"] allows all. */
  scopes: z.array(z.string().min(1)).default(["*"]),
  createdAt: z.number(),
  revokedAt: z.number().nullable().default(null),
  lastSeenAt: z.number().nullable().default(null),
});
export type ClientRecord = z.infer<typeof clientSchema>;

export interface ClientsStoreDeps {
  filePath: string;
  now?: () => number;
}

export class ClientsStore {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly file: string;
  private readonly now: () => number;

  constructor(deps: ClientsStoreDeps) {
    this.file = deps.filePath;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const c of raw.clients ?? []) {
        const parsed = clientSchema.safeParse(c);
        if (parsed.success) this.clients.set(parsed.data.id, parsed.data);
      }
    } catch (err) {
      console.error("[clients] failed to load state:", err instanceof Error ? err.message : err);
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const clients = [...this.clients.values()].sort((a, b) => a.name.localeCompare(b.name));
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, clients }, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[clients] failed to persist state:", err instanceof Error ? err.message : err);
    }
  }

  list(): ClientRecord[] {
    return [...this.clients.values()];
  }

  get(id: string): ClientRecord | null {
    return this.clients.get(id) ?? null;
  }

  /** Create a client; returns the full key exactly once. */
  create(input: { name: string; scopes?: string[] }): { client: ClientRecord; key: string } {
    const { key, keyHash, keyPrefix } = generateClientKey();
    const rec: ClientRecord = {
      id: `cl-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
      name: input.name.trim().slice(0, 80),
      keyHash,
      keyPrefix,
      scopes: input.scopes && input.scopes.length > 0 ? input.scopes : ["*"],
      createdAt: this.now(),
      revokedAt: null,
      lastSeenAt: null,
    };
    this.clients.set(rec.id, rec);
    this.persist();
    return { client: rec, key };
  }

  /** Bearer-key verification; bumps lastSeenAt on success. */
  verify(presentedKey: string): ClientRecord | null {
    const hash = hashKey(presentedKey);
    for (const c of this.clients.values()) {
      if (c.keyHash === hash) {
        if (c.revokedAt != null) return null;
        c.lastSeenAt = this.now();
        this.persist();
        return c;
      }
    }
    return null;
  }

  /** Alias allowed by scopes? "*" grants everything. */
  static canServe(client: ClientRecord, alias: string): boolean {
    return client.scopes.includes("*") || client.scopes.includes(alias);
  }

  revoke(id: string): boolean {
    const c = this.clients.get(id);
    if (!c || c.revokedAt != null) return false;
    c.revokedAt = this.now();
    this.persist();
    return true;
  }

  remove(id: string): boolean {
    if (!this.clients.delete(id)) return false;
    this.persist();
    return true;
  }
}
