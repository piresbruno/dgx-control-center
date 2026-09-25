import { buildApp } from "./app.js";
import { serverEnvSchema } from "./config.js";
import { fakeFleetHubDeps, startFakeFleet, type FakeFleetHandle } from "./fakeFleet.js";
import { fakeJobBehavior, seedMockData } from "./mockData.js";
import type { AgentToServer } from "@cc/shared";
import { NodeDirectory } from "./nodeDirectory.js";
import { DesiredStateStore } from "./desiredState.js";
import { Reconciler } from "./reconciler.js";
import { registerAgentHub } from "./agentHub.js";
import { openDb } from "./stores/db.js";
import { MetricsStore } from "./stores/metricsStore.js";
import { LiveState, type LiveSnapshot } from "./liveState.js";
import { registerBrowserHub } from "./browserHub.js";
import { JobsManager } from "./jobs/jobsManager.js";
import { jobArgv } from "./jobs/commands.js";
import { RecipeStore } from "./serving/recipes.js";
import { DeploymentStore } from "./serving/deployments.js";
import { ServedModelsStore } from "./gateway/servedModels.js";
import { ClientsStore } from "./gateway/clients.js";
import { TracesStore } from "./stores/tracesStore.js";
import { ChatStore } from "./chat/store.js";
import { TraceQueries } from "./stores/traceQueries.js";
import { EnergyStore } from "./stores/energyStore.js";
import { AlertsStore } from "./stores/alertsStore.js";
import { AlertRulesStore } from "./alerts/rules.js";
import { AlertEngine, type EngineSample } from "./alerts/engine.js";
import { AlertDelivery, WebhookStore } from "./alerts/delivery.js";
import { SettingsStore } from "./hardening/settings.js";
import { runMaintenance } from "./hardening/maintenance.js";
import { flattenNumbers } from "./stores/metricsStore.js";
import { ClockProfileStore } from "./power/clockStore.js";
import { ThermalGuard } from "./power/thermal.js";
import { ScheduleStore, activeProfile } from "./power/schedules.js";
import { profileById, resolveProfile } from "./power/profiles.js";
import type { AgentRegistry } from "./agentHub.js";

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
  // All lanIps stay 127.0.0.1: the gateway proxies engine traffic to lanIp, so
  // it must be the loopback the stub engines bind. Fake mode never opens SSH,
  // but the SSH-seam routes need sshUser present; per-node values key the seam.
  await directory.upsert({ id: "dgx1", name: "dgx1", kind: "spark", role: "head", llmPorts: [8888], lanIp: "127.0.0.1", sshUser: "fake-dgx1" });
  await directory.upsert({ id: "dgx2", name: "dgx2", kind: "spark", role: "worker", llmPorts: [8889], lanIp: "127.0.0.1", sshUser: "fake-dgx2" });
  await directory.upsert({ id: "nas1", name: "nas1", kind: "nas", role: "standalone", lanIp: "127.0.0.1", sshUser: "fake-nas1" });
}

// ── Thermal guard (M5): auto-derate on GPU heat, revert on sustained recovery ──
const thermal = new ThermalGuard({
  filePath: "config/thermal-state.json",
  onDerate: (sparkId) => {
    const quiet = resolveProfile(profileById("quiet")!, null);
    const argv = jobArgv("clock-apply", { gpuMaxMhz: quiet.gpuMaxMhz, cpuMaxMhz: quiet.cpuMaxMhz });
    if (argv) jobsManager.dispatch(sparkId, "clock-apply", argv, { timeoutMs: 30_000 });
  },
  onRecover: (sparkId) => {
    const desired = clockStore.desiredFor(sparkId).profile;
    const resolved = resolveProfile(profileById(desired)!, null);
    const argv = jobArgv("clock-apply", { gpuMaxMhz: resolved.gpuMaxMhz, cpuMaxMhz: resolved.cpuMaxMhz });
    if (argv) jobsManager.dispatch(sparkId, "clock-apply", argv, { timeoutMs: 30_000 });
  },
});
// Schedules override the manual desired profile while a window is active;
// outside windows the manual profile (ClockProfileStore) applies again.
setInterval(() => {
  for (const node of directory.list()) {
    const sched = scheduleStore.forNode(node.id);
    const manual = clockStore.desiredFor(node.id).profile;
    const effective = (sched ? activeProfile(sched, new Date()) : null) ?? manual;
    if (desired.get(node.id).clockProfileId !== effective) {
      void desired.patch(node.id, { clockProfileId: effective });
    }
  }
}, 30_000);
setInterval(() => {
  const snap = liveState.snapshot();
  thermal.tick(
    snap.nodes.map((n) => ({
      sparkId: n.sparkId,
      gpuTempC: (n.domains["gpu"] as { tempC?: number | null } | undefined)?.tempC ?? null,
    })),
  );
}, 15_000);

// ── Alert evaluation (M6/F5a): 1-minute-ish tick over the live pipeline ──
setInterval(() => {
  const snap = liveState.snapshot();
  const byId = new Map(snap.nodes.map((n) => [n.sparkId, n]));
  // Sample the DIRECTORY — a pulled agent must still be visible as down.
  const samples: EngineSample[] = directory
    .list()
    .filter((n) => n.kind === "spark")
    .map((n) => ({
      sparkId: n.id,
      reachable: registryRef.current?.isConnected(n.id) ?? false,
      leaves: byId.has(n.id) ? flattenNumbers(byId.get(n.id)!.domains) : {},
      gateway5xxPct: null,
    }));
  // Fleet-level 5xx over the last 10 minutes.
  const k = traceQueries.kpis(Date.now() - 10 * 60_000);
  const g5xx = k.requests > 0 ? k.errorRate * 100 : null;
  alertDelivery.deliver(alertEngine.tick(samples.map((s) => ({ ...s, gateway5xxPct: g5xx }))));
}, 60_000);

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
const scheduleStore = new ScheduleStore({ filePath: "config/clock-schedules.json" });
const alertsStore = new AlertsStore({ db });
const alertRulesStore = new AlertRulesStore({ filePath: "config/alert-rules.json", seed: true });
const settingsStore = new SettingsStore({ filePath: "config/settings.json" });
const traceQueries = new TraceQueries(db);
const tracesStore = new TracesStore({ db });
const chatStore = new ChatStore({ db });
// ── Maintenance (M7): retention + WAL checkpoint at boot and hourly ──
const maintain = (): void => {
  try {
    const report = runMaintenance({
      db,
      metrics: metricsStore,
      traces: tracesStore,
      configDir: "config",
      settings: () => settingsStore.get(),
    });
    console.log(
      `[maintenance] metrics=${JSON.stringify(report.metricsPruned)} traces=${report.tracesPruned} backupsDeleted=${report.backupsDeleted.length} checkpoint=done`,
    );
  } catch (err) {
    console.error("[maintenance] failed:", err instanceof Error ? err.message : err);
  }
};
maintain();
setInterval(maintain, 3_600_000);


const alertEngine = new AlertEngine({ alerts: alertsStore }, () => alertRulesStore.list());
const wsAlertSenders = new Set<(msg: unknown) => void>();
const alertDelivery = new AlertDelivery({
  broadcast: (msg) => {
    for (const send of wsAlertSenders) send(msg);
  },
  webhooks: new WebhookStore({ filePath: "config/alert-webhooks.json" }),
});
// ClockProfileStore is the UI registry; desired-state.json stays the single
// reconciler source of truth — desires write through on set.
const app = buildApp({
  logger: true,
  nodeDirectory: directory,
  jobsManager,
  recipeStore,
  deploymentStore,
  servedModelsStore,
  clientsStore,
  clockStore,
  desiredStore: desired,
  thermalGuard: thermal,
  scheduleStore,
  energyStore: new EnergyStore(db, { kwhCost: env.CC_KWH_COST }),
  metricsStore: metricsStore,
  alertsStore,
  alertRulesStore,
  systemDb: db,
  configDir: "config",
  settingsStore,
  tracesStore: tracesStore,
  chatStore: chatStore,
  traceQueries,
  upstreamAuth: env.CC_UPSTREAM_AUTH ?? null,
  sshIdentity: env.CC_SSH_IDENTITY,
  // Fake fleet: the SSH seams answer from canned outputs instead of SSH.
  ...(fakeFleet
    ? {
        nodeInventoryRunner: async (_host: string, user: string, args: string[]): Promise<string> => {
          const sparkId = user === "fake-dgx2" ? "dgx2" : user === "fake-nas1" ? "nas1" : "dgx1";
          const behavior = fakeJobBehavior(sparkId, ["modelctl", ...args]);
          return behavior?.output?.[0] ?? "[]";
        },
        provisionTransport: async (script: string) => ({
          exitCode: 0,
          stdout: script.includes("uv tool install")
            ? '__CC_MODELCTL__:{"ok":true,"mode":"installed","version":"modelctl 0.5.2","reason":null}\n'
            : '__CC_MODELCTL__:{"ok":true,"mode":"present","version":"modelctl 0.5.2","reason":null}\n',
          stderr: "",
        }),
        // Install/upgrade-agent buttons: succeed via the marker protocol with
        // no SSH. The fake node is already connected, so waitHello passes.
        installTransport: {
          run: async () => ({
            exitCode: 0,
            stdout: '__CC_INSTALL__:{"ok":true,"mode":"user","reason":null}\n',
            stderr: "",
          }),
        },
      }
    : {}),
});
const onDemand = (app as unknown as { onDemand: { startSweeper(): () => void } | undefined }).onDemand;
onDemand?.startSweeper();


const hub = registerAgentHub(app, hubDeps, (scope) =>
  registerBrowserHub(
    scope,
    () => liveState.snapshot(),
    (cb) => {
      broadcastListeners.add(cb);
      return () => broadcastListeners.delete(cb);
    },
    (send) => {
      wsAlertSenders.add(send);
      return () => wsAlertSenders.delete(send);
    },
  ),
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
      seedMockData({
        metrics: metricsStore,
        traces: tracesStore,
        alerts: alertsStore,
        clients: clientsStore,
        servedModels: servedModelsStore,
        recipes: recipeStore,
        deployments: deploymentStore,
        chat: chatStore,
      });
      fleet = await startFakeFleet(`${address.replace("[::1]", "127.0.0.1")}/agent-ws`, 1000, fakeJobBehavior);
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
