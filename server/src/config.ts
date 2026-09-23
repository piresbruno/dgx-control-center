import { z } from "zod";

/**
 * Typed environment contract. Parse at the process boundary
 * (`serverEnvSchema.parse(process.env)`) — tests parse fixtures directly.
 */
export const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5566),
  BIND_HOST: z.string().default("127.0.0.1"),
  /** Local file-backed SQLite (ADR-0003) — one .db under the config volume. */
  CC_DB_PATH: z.string().default("config/controlcenter.db"),
  /** Explicit modelctl binary path; probed on PATH then ~/.local/bin when unset. */
  CC_MODELCTL_PATH: z.string().optional(),
  /** SSH identity key for node bootstrap/inventory (container-safe: no ~ expansion). */
  CC_SSH_IDENTITY: z.string().optional(),
  CC_UPSTREAM_AUTH: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
