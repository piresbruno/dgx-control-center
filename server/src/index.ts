import { buildApp } from "./app.js";
import { serverEnvSchema } from "./config.js";
import { fakeFleetHubDeps, startFakeFleet, type FakeFleetHandle } from "./fakeFleet.js";
import { NodeDirectory } from "./nodeDirectory.js";
import { DesiredStateStore } from "./desiredState.js";
import { Reconciler } from "./reconciler.js";

const fakeFleet = process.argv.includes("--fake-fleet");
const env = serverEnvSchema.parse(process.env);

const directory = new NodeDirectory({ file: "config/nodes.json" });
const desired = new DesiredStateStore({ file: "config/desired-state.json" });
await directory.load();
await desired.load();

let reconciler: Reconciler | null = null;
let fleet: FakeFleetHandle | null = null;
const hubDeps = fakeFleet
  ? fakeFleetHubDeps()
  : {
      validToken: (t: string) => t === (process.env.CC_AGENT_TOKEN ?? "dev-agent-token"),
      isKnownNode: (id: string) => directory.isKnown(id),
      nodeConfig: (id: string) => desired.toRuntimeConfig(id),
      minAgentVersion: "0.1.0",
      onAgentMessage: (sparkId: string, msg: { type: string }) => reconciler?.observeMessage(sparkId, msg),
    };

const app = buildApp({ logger: true, agentHubDeps: hubDeps });

const registry = app.agentRegistry;
if (registry) {
  reconciler = new Reconciler({ directory, desired, registry });
  // Reconciler tick + watchdog sweep (F1a); cadences move into settings at M1+.
  const ticker = setInterval(() => reconciler?.tick(Date.now()), 2_000);
  const watchdog = setInterval(() => registry.sweep(Date.now(), 30_000), 10_000);
  ticker.unref();
  watchdog.unref();
  app.addHook("onClose", async () => {
    clearInterval(ticker);
    clearInterval(watchdog);
  });
}
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
