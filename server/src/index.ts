import { buildApp } from "./app.js";
import { serverEnvSchema } from "./config.js";
import { fakeFleetHubDeps, startFakeFleet } from "./fakeFleet.js";

const fakeFleet = process.argv.includes("--fake-fleet");
const env = serverEnvSchema.parse(process.env);
const app = buildApp({
  logger: true,
  agentHubDeps: fakeFleet ? fakeFleetHubDeps() : undefined,
});

app
  .listen({ port: env.PORT, host: env.BIND_HOST })
  .then(async (address) => {
    app.log.info(`ControlCenter ${address} · db ${env.CC_DB_PATH}${fakeFleet ? " · FAKE FLEET" : ""}`);

    const registry = app.agentRegistry;
    if (registry) {
      // Watchdog sweep (F1a): cadence/timeout move into typed settings at M1+.
      const watchdog = setInterval(() => registry.sweep(Date.now(), 30_000), 10_000);
      watchdog.unref();
      app.addHook("onClose", async () => clearInterval(watchdog));
    }

    if (fakeFleet) {
      const fleet = await startFakeFleet(`${address.replace("[::1]", "127.0.0.1")}/agent-ws`);
      app.addHook("onClose", () => fleet.stop());
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
