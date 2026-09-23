import { buildApp } from "./app.js";
import { serverEnvSchema } from "./config.js";
import { fakeFleetHubDeps, startFakeFleet, type FakeFleetHandle } from "./fakeFleet.js";
import type { AgentToServer } from "@cc/shared";
import { NodeDirectory } from "./nodeDirectory.js";
import { DesiredStateStore } from "./desiredState.js";
import { Reconciler } from "./reconciler.js";
import { openDb } from "./stores/db.js";
import { MetricsStore } from "./stores/metricsStore.js";
import { LiveState, type LiveSnapshot } from "./liveState.js";
import { registerBrowserHub } from "./browserHub.js";

const fakeFleet = process.argv.includes("--fake-fleet");
const env = serverEnvSchema.parse(process.env);

const directory = new NodeDirectory({ file: "config/nodes.json" });
const desired = new DesiredStateStore({ file: "config/desired-state.json" });
await directory.load();
await desired.load();

const db = openDb(env.CC_DB_PATH);
const metricsStore = new MetricsStore(db);

const liveState = new LiveState({
  describe: (id) => {
    const node = directory.get(id);
    return node ? { name: node.name, kind: node.kind, role: node.role } : null;
  },
  stateOf: (id) => reconciler?.stateOf(id) ?? "provisioning",
});

let reconciler: Reconciler | null = null;
let fleet: FakeFleetHandle | null = null;
const onAgentMessage = (sparkId: string, msg: AgentToServer) => {
  reconciler?.observeMessage(sparkId, msg);
  liveState.observeMessage(sparkId, msg);
  if (msg.type === "metrics") metricsStore.ingest(sparkId, msg);
};
const hubDeps = fakeFleet
  ? fakeFleetHubDeps(onAgentMessage)
  : {
      agentToken: () => process.env.CC_AGENT_TOKEN ?? "dev-agent-token",
      isKnownNode: (id: string) => directory.isKnown(id),
      nodeConfig: (id: string) => desired.toRuntimeConfig(id),
      minAgentVersion: "0.1.0",
      onAgentMessage,
    };

const broadcastListeners = new Set<(snapshot: LiveSnapshot) => void>();
const broadcast = (): void => {
  const snapshot = liveState.snapshot();
  for (const cb of broadcastListeners) cb(snapshot);
};

const app = buildApp({ logger: true, agentHubDeps: hubDeps, nodeDirectory: directory });
registerBrowserHub(app, () => liveState.snapshot(), (cb) => {
  broadcastListeners.add(cb);
  return () => broadcastListeners.delete(cb);
});

const registry = app.agentRegistry;
if (registry) {
  reconciler = new Reconciler({
    directory,
    desired,
    registry,
    onStateChange: () => broadcast(),
    onConfigUpdate: () => broadcast(),
  });
  const ticker = setInterval(() => reconciler?.tick(Date.now()), 2_000);
  const watchdog = setInterval(() => registry.sweep(Date.now(), 30_000), 10_000);
  ticker.unref();
  watchdog.unref();
  app.addHook("onClose", async () => {
    clearInterval(ticker);
    clearInterval(watchdog);
  });
}

// Metrics flush + retention prune (F5); cadences move into settings at M1+.
const flushTimer = setInterval(() => {
  metricsStore.flush();
  broadcast();
}, 5_000);
const pruneTimer = setInterval(() => metricsStore.prune(), 3_600_000);
flushTimer.unref();
pruneTimer.unref();
app.addHook("onClose", async () => {
  clearInterval(flushTimer);
  clearInterval(pruneTimer);
  metricsStore.flush();
  db.close();
});
if (fakeFleet) {
  app.addHook("onClose", () => fleet?.stop());
}

app
  .listen({ port: env.PORT, host: env.BIND_HOST })
  .then(async (address) => {
    app.log.info(`ControlCenter ${address} · db ${env.CC_DB_PATH}${fakeFleet ? " · FAKE FLEET" : ""}`);
    if (fakeFleet) {
      fleet = await startFakeFleet(`${address.replace("[::1]", "127.0.0.1")}/agent-ws`);
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

/** Graceful shutdown: flush stores here as they land (M1+). */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
