import { z } from "zod";
import { runSsh, type SshResult, type SshTarget } from "../transport/ssh.js";

/**
 * modelctl/uv provisioning bootstrap job (M2). Per ADR-0002 SSH is
 * bootstrap/repair only: this validates modelctl on a node and installs it
 * (uv → `uv tool install` from the modelctl git repo) when missing.
 * Same marker protocol as install-agent: one final JSON line on stdout.
 */

export const MARKER_PREFIX = "__CC_MODELCTL__:";

export interface ProvisionOutcome {
  ok: boolean;
  mode: "present" | "installed" | "missing" | "failed";
  version: string | null;
  reason: string | null;
}

export const provisionMarkerSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(["present", "installed", "missing", "failed"]),
  version: z.string().nullable(),
  reason: z.string().nullable(),
});

const MODELCTL_REPO = "https://github.com/piresbruno/modelctl";

/** Validation-only script: reports presence + version, installs nothing. */
export function buildModelctlCheckScript(): string {
  return `set -eu
export PATH="$HOME/.local/bin:$PATH"
if command -v modelctl >/dev/null 2>&1; then
  printf '${MARKER_PREFIX}{"ok":true,"mode":"present","version":"%s","reason":null}\\n' "$(modelctl --version 2>/dev/null | head -1)"
else
  echo '${MARKER_PREFIX}{"ok":false,"mode":"missing","version":null,"reason":"modelctl not found"}'
fi
`;
}

/** Full provisioning script: validate → install uv if needed → uv tool install. */
export function buildProvisionScript(repoUrl: string = MODELCTL_REPO): string {
  return `set -eu
export PATH="$HOME/.local/bin:$PATH"
if command -v modelctl >/dev/null 2>&1; then
  printf '${MARKER_PREFIX}{"ok":true,"mode":"present","version":"%s","reason":null}\\n' "$(modelctl --version 2>/dev/null | head -1)"
  exit 0
fi
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
fi
if ! command -v uv >/dev/null 2>&1; then
  echo '${MARKER_PREFIX}{"ok":false,"mode":"failed","version":null,"reason":"uv missing after installer"}'
  exit 0
fi
if uv tool install --force "${repoUrl}" >/tmp/cc-modelctl-install.log 2>&1; then
  printf '${MARKER_PREFIX}{"ok":true,"mode":"installed","version":"%s","reason":null}\\n' "$(modelctl --version 2>/dev/null | head -1)"
else
  echo '${MARKER_PREFIX}{"ok":false,"mode":"failed","version":null,"reason":"uv tool install failed (see /tmp/cc-modelctl-install.log)"}'
fi
`;
}

function parseMarker(stdout: string): ProvisionOutcome | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(MARKER_PREFIX)) continue;
    const parsed = provisionMarkerSchema.safeParse(JSON.parse(line.slice(MARKER_PREFIX.length)));
    if (parsed.success) return parsed.data;
  }
  return null;
}

export interface ProvisionDeps {
  /** Test seam: overrides the SSH run. */
  transport?: (script: string) => Promise<SshResult>;
  timeoutMs?: number;
}

/** Run check-or-install on one node; never throws. */
export async function provisionModelctl(
  target: SshTarget,
  deps: ProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const run =
    deps.transport ?? ((script: string) => runSsh(target, script, { timeoutMs: deps.timeoutMs ?? 300_000 }));
  const result = await run(buildProvisionScript());
  const marker = parseMarkerSafe(result);
  return (
    marker ?? {
      ok: false,
      mode: "failed",
      version: null,
      reason: result.exitCode === 0 ? "no marker in output" : `ssh exited ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`,
    }
  );
}

function parseMarkerSafe(result: SshResult): ProvisionOutcome | null {
  try {
    return parseMarker(result.stdout);
  } catch {
    return null;
  }
}

/** Validate-only variant for the Models page doctor. */
export async function checkModelctl(target: SshTarget, deps: ProvisionDeps = {}): Promise<ProvisionOutcome> {
  const run =
    deps.transport ?? ((script: string) => runSsh(target, script, { timeoutMs: deps.timeoutMs ?? 30_000 }));
  const result = await run(buildModelctlCheckScript());
  const marker = parseMarkerSafe(result);
  return marker ?? { ok: false, mode: "failed", version: null, reason: `ssh exited ${result.exitCode}` };
}
