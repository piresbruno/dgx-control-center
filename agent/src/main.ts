import { VERSION, PROTOCOL_VERSION } from "@cc/shared";

export function agentVersionString(): string {
  return `controlcenter-agent ${VERSION} · proto ${PROTOCOL_VERSION}`;
}

/** CLI dispatch only when executed directly (imports stay side-effect free for tests). */
const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : null;
if (invoked === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    console.log(agentVersionString());
  } else {
    // M1 lands here: outbound WS to the dashboard, watchdog, collectors (F1a).
    console.error("agent runtime connects in M1 — see PLAN.md; use --version");
    process.exitCode = 2;
  }
}
