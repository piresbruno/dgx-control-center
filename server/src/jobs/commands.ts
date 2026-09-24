import { z } from "zod";
import { buildApplyScript, buildClockStatusCommand, buildInstallClockScript } from "../power/helper.js";
import { buildFabricProbeCommand } from "../fleet/fabric.js";
import { benchParamsSchema, buildBenchScript } from "../bench/bench.js";

/**
 * Server-side job command registry: REST clients name a KIND + params; the
 * argv is resolved here. Never accept raw argv from the API — jobs run on
 * real nodes. Children spawn without a shell, but params still get strict
 * allowlists so bad input fails at the API boundary.
 */

const repoId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/, "invalid model identifier");
const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, "invalid host");

export const jobParamsSchemas = {
  "modelctl-version": z.object({}).strict().default({}),
  "modelctl-list-local": z.object({}).strict().default({}),
  "uv-version": z.object({}).strict().default({}),
  "modelctl-download": z.object({ source: repoId }).strict(),
  "modelctl-sync-local": z.object({ model: repoId }).strict(),
  "modelctl-push": z.object({ model: repoId, host: hostname }).strict(),
  "modelctl-delete-local": z.object({ model: repoId }).strict(),
  "clock-status": z.object({}).strict().default({}),
  "clock-install": z.object({ user: hostname }).strict(),
  "clock-apply": z
    .object({
      gpuMaxMhz: z.number().int().min(1).max(100000).nullable().optional(),
      cpuMaxMhz: z.number().int().min(1).max(10000000).nullable().optional(),
    })
    .strict()
    .refine((v) => v.gpuMaxMhz != null || v.cpuMaxMhz != null, "at least one cap required"),
  "fabric-probe": z.object({}).strict().default({}),
  "capability-sweep": z.object({}).strict().default({}),
  "bench-decode": benchParamsSchema.strict(),
  "bench-prefill": benchParamsSchema.strict(),
} as const;

export type JobKind = keyof typeof jobParamsSchemas;
export const JOB_KINDS = Object.keys(jobParamsSchemas);

/** Resolve a job kind + raw params to argv. Null when kind/params invalid. */
export function jobArgv(kind: string, params: unknown = {}): string[] | null {
  const schema = (jobParamsSchemas as Record<string, z.ZodTypeAny | undefined>)[kind];
  if (!schema) return null;
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) return null;
  const p = parsed.data as Record<string, string>;
  switch (kind) {
    case "modelctl-version":
      return ["modelctl", "--version"];
    case "modelctl-list-local":
      return ["modelctl", "list", "--local", "--json"];
    case "uv-version":
      return ["uv", "--version"];
    case "modelctl-download":
      return ["modelctl", "download", p.source!];
    case "modelctl-sync-local":
      return ["modelctl", "sync-local", p.model!];
    case "modelctl-push":
      return ["modelctl", "push", "--host", p.host!, p.model!];
    case "modelctl-delete-local":
      return ["modelctl", "delete-local", p.model!];
    case "clock-status":
      return ["bash", "-c", buildClockStatusCommand()];
    case "fabric-probe":
      return ["bash", "-c", buildFabricProbeCommand()];
    case "capability-sweep": {
      const script = [
        "python3 - <<'PY'",
        "import json, subprocess, shutil",
        "def ver(cmd):",
        "    try:",
        "        return subprocess.check_output(cmd, shell=True, text=True, timeout=10).strip()",
        "    except Exception:",
        "        return None",
        "print(json.dumps({",
        "    'node': ver('uname -sr'),",
        "    'nodejs': ver('node --version'),",
        "    'modelctl': ver('PATH=$HOME/.local/bin:$PATH modelctl --version'),",
        "    'uv': ver('PATH=$HOME/.local/bin:$PATH uv --version'),",
        "    'docker': ver('docker --version'),",
        "    'ccClock': 'installed' if __import__('os').path.exists('/usr/local/bin/cc-clock') else 'missing',",
        "}))",
        "PY",
      ].join("\n");
      return ["bash", "-c", script];
    }
    case "bench-decode":
      return ["bash", "-c", buildBenchScript("decode", benchParamsSchema.parse(p))];
    case "bench-prefill":
      return ["bash", "-c", buildBenchScript("prefill", benchParamsSchema.parse(p))];
    case "clock-install":
      return ["bash", "-c", buildInstallClockScript(p.user!)];
    case "clock-apply": {
      const ops: string[] = [];
      if (p.gpuMaxMhz != null) ops.push(`sudo -n /usr/local/bin/cc-clock gpu-lock ${p.gpuMaxMhz}`);
      if (p.cpuMaxMhz != null) ops.push(`sudo -n /usr/local/bin/cc-clock cpu-max ${Number(p.cpuMaxMhz) * 1000}`);
      const script = [
        "test -x /usr/local/bin/cc-clock || { echo 'cc-clock helper missing — run Install clock control first' >&2; exit 127; }",
        "sudo -n /usr/local/bin/cc-clock check 2>/dev/null || { echo 'passwordless sudo for cc-clock required — install first' >&2; exit 126; }",
        ...(ops.length > 0 ? ops : ["sudo -n /usr/local/bin/cc-clock gpu-reset", "sudo -n /usr/local/bin/cc-clock cpu-reset"]),
      ].join("\n");
      return ["bash", "-c", script];
    }
    default:
      return null;
  }
}
