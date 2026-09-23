import { buildApp } from "./app.js";
import { serverEnvSchema } from "./config.js";

const env = serverEnvSchema.parse(process.env);
const app = buildApp({ logger: true });

app
  .listen({ port: env.PORT, host: env.BIND_HOST })
  .then((address) => app.log.info(`ControlCenter ${address} · db ${env.CC_DB_PATH}`))
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
