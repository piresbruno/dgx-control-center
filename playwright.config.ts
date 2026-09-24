import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * E2E on the FAKE fleet, fully isolated from the live deployment:
 *  - the API boots with --fake-fleet in a scratch cwd (scratch config/ + db) on :5599
 *  - Vite serves the SPA on :5199 with /api proxied to :5599 (CC_API_TARGET)
 */
const repo = path.resolve(import.meta.dirname ?? ".");
const scratch = "/tmp/cc-e2e-fleet";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:5199" },
  webServer: [
    {
      command: `sh -c 'mkdir -p ${scratch}/config && cd ${scratch} && PORT=5599 ${repo}/node_modules/.bin/tsx ${repo}/server/src/index.ts --fake-fleet'`,
      url: "http://127.0.0.1:5599/api/health",
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `${repo}/node_modules/.bin/vite --host 127.0.0.1 --config ${repo}/web/vite.config.ts --port 5199 --strictPort ${repo}/web`,
      url: "http://127.0.0.1:5199",
      reuseExistingServer: false,
      timeout: 90_000,
      env: { CC_API_TARGET: "http://127.0.0.1:5599" },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
