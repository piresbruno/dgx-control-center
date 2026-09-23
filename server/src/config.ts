import { z } from "zod";

/**
 * Typed environment contract. Parse at the process boundary
 * (`serverEnvSchema.parse(process.env)`) — tests parse fixtures directly.
 */
export const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5555),
  BIND_HOST: z.string().default("127.0.0.1"),
  /** Local file-backed SQLite (ADR-0003) — one .db under the config volume. */
  CC_DB_PATH: z.string().default("config/controlcenter.db"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
