import { buildApp } from "./app.js";
import { serverEnvSchema } from "./config.js";
import { fakeFleetHubDeps, startFakeFleet, type FakeFleetHandle } from "./fakeFleet.js";
import type { AgentToServer } from "@cc/shared";
import { NodeDirectory } from "./nodeDirectory.js";
import { DesiredStateStore } from "./desiredState.js";
import { Reconciler } from "./reconciler.js";
import { registerAgentHub } from "./agentHub.js";
import { openDb } from "./stores/db.js";
import { MetricsStore } from "./stores/metricsStore.js";
import { LiveState, type LiveSnapshot } from "./liveState.js";
import { registerBrowserHub } from "./browserHub.js";
import { ModelctlService, resolveModelctlPath } from "./modelctl/service.js";
import { JobsManager } from "./jobs/jobsManager.js";
import { RecipeStore } from "./serving/recipes.js";
import { DeploymentStore } from "./serving/deployments.js";
import { ServedModelsStore } from "./gateway/servedModels.js";
import { ClientsStore } from "./gateway/clients.js";
import { TracesStore } from "./stores/tracesStore.js";
import { TraceQueries } from "./stores/traceQueries.js";
import { ClockProfileStore } from "./power/clockStore.js";
import type { AgentRegistry } from "./agentHub.js";

const fakeFleet = process.argv.includes("--fake-fleet");
const env = serverEnvSchema.parse(process.env);

const directory = new NodeDirectory({ file: "config/nodes.json" });
const desired = new DesiredStateStore({ file: "config/desired-state.json" });
await directory.load();
await desired.load();

const db = openDb(env.CC_DB_PATH);
const metricsStore = new MetricsStore(db);

const modelctlPath = await resolveModelctlPath(env.CC_MODELCTL_PATH);
if (!modelctlPath) console.warn("[modelctl] binary not found — model inventories will error until installed");
const modelctl = new ModelctlService({ modelctlPath: modelctlPath ?? undefined });

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
  jobsManager?.observeMessage(sparkId, msg);
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

if (fakeFleet) {
  // The fake fleet must be registered nodes so the reconciler tracks them.
  await directory.upsert({ id: "dgx1", name: "dgx1", kind: "spark", role: "head", llmPorts: [8888] });
  await directory.upsert({ id: "dgx2", name: "dgx2", kind: "spark", role: "worker", llmPorts: [8889] });
  await directory.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone" });
}

const registryRef: { current: AgentRegistry | null } = { current: null };
const jobsManager = new JobsManager({
  send: (nodeId, msg) => registryRef.current?.send(nodeId, msg) ?? false,
  isConnected: (nodeId) => registryRef.current?.isConnected(nodeId) ?? false,
});
const recipeStore = new RecipeStore({ filePath: "config/serve-recipes.json" });
const servedModelsStore = new ServedModelsStore({ filePath: "config/served-models.json" });
const clientsStore = new ClientsStore({ filePath: "config/clients.json" });
const deploymentStore = new DeploymentStore({ filePath: "config/serve-deployments.json" });
const clockStore = new ClockProfileStore({ filePath: "config/clock-profiles.json" });
// ClockProfileStore is the UI registry; desired-state.json stays the single
// reconciler source of truth — desires write through on set.
const app = buildApp({
  logger: true,
  nodeDirectory: directory,
  modelctl,
  jobsManager,
  recipeStore,
  deploymentStore,
  servedModelsStore,
  clientsStore,
  clockStore,
  desiredStore: desired,
  tracesStore: new TracesStore({ db }),
  traceQueries: new TraceQueries(db),
  upstreamAuth: env.CC_UPSTREAM_AUTH ?? null,
  sshIdentity: env.CC_SSH_IDENTITY,
});
const onDemand = (app as unknown as { onDemand: { startSweeper(): () => void } | undefined }).onDemand;
onDemand?.startSweeper();
const hub = registerAgentHub(app, hubDeps, (scope) =>
  registerBrowserHub(scope, () => liveState.snapshot(), (cb) => {
    broadcastListeners.add(cb);
    return () => broadcastListeners.delete(cb);
  }),
);
app.decorate("agentRegistry", hub);


const registry = hub;
if (registry) {
  registryRef.current = registry;
  reconciler = new Reconciler({
    directory,
    desired,
    registry,
    onStateChange: () => broadcast(),
    onConfigUpdate: () => broadcast(),
  });
  const ticker = setInterval(() => reconciler?.tick(Date.now()), 2_000);
  const watchdog = setInterval(() => {
    registry.sweep(Date.now(), 30_000);
    for (const job of jobsManager.list({ active: true })) {
      if (!registry.isConnected(job.nodeId)) jobsManager.onNodeDisconnected(job.nodeId);
    }
  }, 10_000);
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
