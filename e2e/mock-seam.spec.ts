import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Mock-seam guard (CC-1 P4): `--fake-fleet` must seed every previously-empty
 * page through the SAME routes the real fleet fills — and dropping the flag
 * must return the honest empty stores. The web app contains no mock logic, so
 * the two halves below are the whole contract.
 */

const repo = path.resolve(import.meta.dirname ?? "..", "..");
const realScratch = "/tmp/cc-e2e-real";

test("fake fleet: every previously-empty page has seeded data", async ({ page, request }) => {
  // API-level: the routes themselves carry rows.
  const clients = await (await request.get("/api/gateway/clients")).json();
  expect(clients.clients.length).toBeGreaterThanOrEqual(3);
  const traces = await (await request.get("/api/analysis/traces?limit=50")).json();
  expect(traces.traces.length).toBeGreaterThanOrEqual(40);
  const served = await (await request.get("/api/gateway/served-models")).json();
  expect(served.models.map((m: { alias: string }) => m.alias)).toEqual(
    expect.arrayContaining(["glm-live", "qwen-local"])
  );
  const deployments = await (await request.get("/api/serve/deployments")).json();
  expect(deployments.deployments.length).toBeGreaterThanOrEqual(1);

  // UI-level: the pages render those rows.
  await page.goto("/");
  await page.getByTestId("nav-clients").click();
  await expect(page.getByTestId("clients-table")).toContainText("claude-code");

  await page.getByTestId("nav-analysis").click();
  await expect(page.getByTestId("traces-table")).toContainText("glm-live");

  await page.getByTestId("nav-serve").click();
  await expect(page.getByTestId("deployments-table")).toContainText("GLM 5.3");

  await page.getByTestId("nav-recipes").click();
  await expect(page.getByTestId("recipes-table")).toContainText("GLM 5.3");

  await page.getByTestId("nav-router").click();
  await expect(page.getByTestId("routes-table")).toContainText("glm-live");

  await page.getByTestId("nav-models").click();
  await expect(page.getByTestId("catalog-table")).toContainText("GLM-5.3-Flash");
});

test("real mode (no flag): the same routes are honestly empty", async () => {
  test.setTimeout(120_000);
  const PORT = 5699;
  // An interrupted earlier run can leave an orphan holding the port; take it back.
  try {
    execFileSync("sh", ["-c", `lsof -ti tcp:${PORT} | xargs kill -9 2>/dev/null || true`]);
  } catch {
    /* port already free */
  }
  fs.rmSync(realScratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(realScratch, "config"), { recursive: true });
  fs.symlinkSync(path.join(repo, "web"), path.join(realScratch, "web")); // built UI, if present

  // Strip loader-injected env (Playwright sets NODE_OPTIONS for its TS pipeline;
  // it breaks the child's own tsx bootstrap) and talk to the direct tsx binary.
  const { NODE_OPTIONS: _nodeOptions, ...env } = process.env;
  const logFd = fs.openSync(path.join(realScratch, "server.log"), "w");
  const server = spawn(
    path.join(repo, "node_modules/.bin/tsx"),
    [path.join(repo, "server/src/index.ts")], // note: NO --fake-fleet
    {
      cwd: realScratch,
      env: { ...env, PORT: String(PORT), CC_DB_PATH: path.join(realScratch, "cc.db") },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    }
  );
  server.unref();
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(base + "/api/health")).ok;
          } catch {
            return false;
          }
        },
        { timeout: 60_000, message: `server never came up:\n${fs.readFileSync(path.join(realScratch, "server.log"), "utf8").slice(-800)}` }
      )
      .toBe(true);

    const get = async (p: string) => (await (await fetch(base + p)).json()) as Record<string, unknown>;
    expect((await get("/api/gateway/clients")).clients).toEqual([]);
    expect((await get("/api/analysis/traces?limit=50")).traces).toEqual([]);
    expect((await get("/api/alerts")).alerts).toEqual([]);
    expect((await get("/api/gateway/served-models")).models).toEqual([]);
    expect((await get("/api/serve/deployments")).deployments).toEqual([]);
    expect((await get("/api/recipes")).recipes).toEqual([]);
  } finally {
    try {
      process.kill(-server.pid!, "SIGKILL"); // whole group
    } catch {
      server.kill("SIGKILL");
    }
    fs.closeSync(logFd);
    fs.rmSync(realScratch, { recursive: true, force: true });
  }
});
