import { z } from "zod";

/**
 * install-agent bootstrap job (M1): server-side script builder + orchestration.
 * Per ADR-0002 this is the ONLY thing SSH does at runtime-adjacent scope:
 * stage the agent bundle, write config, install a systemd unit (system unit
 * via passwordless sudo, else user unit + linger hint), start it, and wait
 * for the agent's hello on the hub.
 */

export const installInputSchema = z.object({
  sparkId: z.string().min(1),
  dashboardUrl: z.string().url(),
  token: z.string().min(1),
  /** The esbuild-bundled agent (raw bytes; base64-embedded into the script). */
  agentBundle: z.string(),
  sshUser: z.string().min(1),
});
export type InstallInput = z.infer<typeof installInputSchema>;

export interface InstallOutcome {
  ok: boolean;
  mode: "system" | "user";
  reason: string | null;
}

export const MARKER_PREFIX = "__CC_INSTALL__:";

const AGENT_DIR = "$HOME/.controlcenter/agent";
const UNIT_NAME = "controlcenter-agent";

/** systemd unit for the agent (ADR-0002: Restart=always resilience floor). */
export function buildSystemdUnit(input: { sshUser: string; nodeBin: string; agentPath: string }): string {
  return [
    "[Unit]",
    "Description=ControlCenter agent",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `User=${input.sshUser}`,
    `ExecStart=${input.nodeBin} ${input.agentPath} run`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Pure script builder — the deployable payload for one install run. */
export function buildInstallScript(input: InstallInput): string {
  const bundleB64 = Buffer.from(input.agentBundle, "utf8").toString("base64");
  const configJson = JSON.stringify({
    dashboardUrl: input.dashboardUrl,
    sparkId: input.sparkId,
    token: input.token,
  });
  return `set -eu
AGENT_DIR="${AGENT_DIR}"
UNIT_NAME="${UNIT_NAME}"
mkdir -p "$AGENT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "${MARKER_PREFIX}{\\"ok\\":false,\\"mode\\":\\"system\\",\\"reason\\":\\"node missing (>=22 required): install per docs/RUNBOOKS.md section 1\\"}"
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "${MARKER_PREFIX}{\\"ok\\":false,\\"mode\\":\\"system\\",\\"reason\\":\\"node too old: $NODE_MAJOR, >=22 required\\"}"
  exit 1
fi

printf '%s' '${bundleB64}' | base64 -d > "$AGENT_DIR/agent.mjs"
cat > "$AGENT_DIR/config.json" <<'CC_CONFIG_JSON'
${configJson}
CC_CONFIG_JSON

SYSTEM_UNIT=/etc/systemd/system/\${UNIT_NAME}.service
USER_UNIT_DIR=$HOME/.config/systemd/user
MODE=system
if sudo -n true 2>/dev/null; then
  cat > "$AGENT_DIR/unit" <<'CC_UNIT'
__UNIT_BODY__
CC_UNIT
  sudo -n cp "$AGENT_DIR/unit" "$SYSTEM_UNIT"
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now "$UNIT_NAME"
else
  MODE=user
  mkdir -p "$USER_UNIT_DIR"
  cat > "$USER_UNIT_DIR/\${UNIT_NAME}.service" <<'CC_UNIT'
__UNIT_BODY__
CC_UNIT
  systemctl --user daemon-reload || true
  systemctl --user enable --now "$UNIT_NAME" 2>/dev/null || {
    echo "${MARKER_PREFIX}{\\"ok\\":false,\\"mode\\":\\"user\\",\\"reason\\":\\"systemctl --user failed: enable-linger for ${input.sshUser} (loginctl enable-linger) and retry\\"}"
    exit 1
  }
  loginctl enable-linger "${input.sshUser}" 2>/dev/null || true
fi

echo "${MARKER_PREFIX}{\\"ok\\":true,\\"mode\\":\\"$MODE\\",\\"reason\\":null}"
`.replace("__UNIT_BODY__", buildSystemdUnit({ sshUser: input.sshUser, nodeBin: "$(command -v node)", agentPath: "$AGENT_DIR/agent.mjs" }));
}

const markerSchema = z.object({ ok: z.boolean(), mode: z.enum(["system", "user"]), reason: z.string().nullable() });

/** Parse the first marker line from combined output. */
export function parseInstallMarker(output: string): InstallOutcome | null {
  const idx = output.indexOf(MARKER_PREFIX);
  if (idx === -1) return null;
  try {
    const line = output.slice(idx + MARKER_PREFIX.length).split("\n")[0]!.trim();
    const parsed = markerSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Transport port — real impl rides the SSH module; tests inject fakes. */
export interface BootstrapTransport {
  run(script: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export interface WaitHello {
  (sparkId: string, timeoutMs: number): Promise<boolean>;
}

export interface RunInstallDeps {
  transport: BootstrapTransport;
  waitHello: WaitHello;
  now?: () => number;
  helloTimeoutMs?: number;
}

/** Orchestrate one install: run script, parse marker, wait for hub hello. */
export async function runInstallAgent(
  target: { host: string; user: string },
  input: InstallInput,
  deps: RunInstallDeps,
): Promise<InstallOutcome & { helloSeen: boolean }> {
  const script = buildInstallScript(input);
  const result = await deps.transport.run(script);
  const marker = parseInstallMarker(result.stdout + result.stderr);
  if (!marker || !marker.ok) {
    return {
      ok: false,
      mode: marker?.mode ?? "system",
      reason: marker?.reason ?? result.stderr.trim().slice(0, 500) ?? "no marker in output",
      helloSeen: false,
    };
  }
  const helloSeen = await deps.waitHello(input.sparkId, deps.helloTimeoutMs ?? 60_000);
  return { ...marker, helloSeen };
}
