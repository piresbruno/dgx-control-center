import { z } from "zod";
import { readFile } from "node:fs/promises";

export const agentConfigSchema = z.object({
  dashboardUrl: z.string().url(),
  sparkId: z.string().min(1),
  token: z.string().min(1),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Pure: merge file values with CLI args, then validate. */
export function parseAgentConfig(
  fromFile: unknown,
  args: Record<string, string | undefined> = {},
): AgentConfig {
  const fileValues = agentConfigSchema.partial().parse(fromFile);
  const merged = { ...fileValues, ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) };
  return agentConfigSchema.parse(merged);
}

/** Load the node config written by the install job; CLI args win. */
export async function loadAgentConfig(
  file: string,
  args: Record<string, string | undefined> = {},
): Promise<AgentConfig> {
  return parseAgentConfig(JSON.parse(await readFile(file, "utf8")), args);
}
