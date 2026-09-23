import { join } from "node:path";
import { buildCollectors } from "./collectors.js";

const collectors = buildCollectors();
import { loadAgentConfig } from "./config.js";
import { AgentDaemon } from "./daemon.js";
import { notifyReady, startWatchdog } from "./sdNotify.js";
import { VERSION } from "@cc/shared";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(`controlcenter-agent ${VERSION} · proto 1`);
} else if (args[0] === "run") {
  const configPath = args[1] ?? join(process.env["HOME"] ?? "~", ".controlcenter", "agent", "config.json");
  const config = await loadAgentConfig(configPath, {
    dashboardUrl: process.env["CC_DASHBOARD_URL"],
    sparkId: process.env["CC_SPARK_ID"],
    token: process.env["CC_AGENT_TOKEN"],
  });
  const daemon = new AgentDaemon({
    dashboardUrl: config.dashboardUrl,
    sparkId: config.sparkId,
    token: config.token,
    role: (process.env["CC_ROLE"] as "head" | "worker" | "standalone") ?? "standalone",
    llmPorts: (process.env["CC_LLM_PORTS"] ?? "")
      .split(",")
      .map((p) => Number(p.trim()))
      .filter((p) => p > 0),
    intervals: { cpu: 1_000, gpu: 1_000, memory: 5_000, network: 5_000, storage: 5_000 },
    collect: (domain, ts) => collectors[domain]?.(ts) ?? null,
    stateFile: join(process.env["HOME"] ?? "~", ".controlcenter", "agent", "state.json"),
    clockApplier: undefined, // bound to the spark-clock helper at M5
    onLog: (line) => console.log(`[agent] ${line}`),
  });
  void notifyReady().then((sent) => {
    if (sent) startWatchdog();
    daemon.start();
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      daemon.stop();
      process.exit(0);
    });
  }
} else {
  console.error("usage: agent.mjs run | --version");
  process.exitCode = 2;
}
