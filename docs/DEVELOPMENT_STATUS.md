# Development Status — pick-up-elsewhere note

_Last updated: 2026-09-24. Branch `main`. 285 tests, ~86% lines coverage, `.agentic/bin/validate` green._

## Where we are

**M0–M4 complete (all gates passed on the real 3-node fleet), M5 Power & Clocks 6/10.** Full task state lives in the PLAN.md roadmap + the session todo tracker (56→62/92 done at last commit). Gate outcomes are recorded inline in PLAN.md under each milestone.

### Done and verified on real hardware

- **M1 Fleet Core** — agent WebSocket hub, live metrics (cpu/gpu/memory/network/storage), SQLite 1m/1h/1d rollups, node directory, desired-state reconciler, Overview/Node pages. Both DGXs report `consistent` via `/ws`.
- **M2 Model Plane** — modelctl service (TTL caches, stale-serve), remote job channel (`job-run/out/exit`), placement planner, modelctl provisioning over SSH, Models page (catalog/presence/download queue). Gate: download → sync → visible on NAS+DGX.
- **M3 Serving** — recipe registry + read-only probe (verbs, `.env` public keys, secret presence-only, container scrape, git drift), deployment supervisor + 10-state join, multi-node exact-delta guard, VRAM/UMA budget estimator, Serve/Recipes pages, per-node pass-through `/llm/node/:id/:port/*`. Gate: scratch-engine lifecycle register→start→healthy→stop + orphan recovery after dashboard restart (TP=2 start deferred by owner decision — recorded in PLAN.md).
- **M4 Gateway & Analysis** — served-models router (healthy-first chains, round-robin), `/v1` gateway with hashed client keys/scopes and client-header-wins auth injection, request recorder (TTFT/ITL/tokens), SQLite traces (caps/redact/retention), aggregations, Prometheus + CSV, Analysis/Clients/Router pages. Gate: live keyed routing to the real GLM engine (alias rewrite, `'OK'` completion, usage recorded) + 502 failover drill with attempts trail.
- **M5 (partial)** — clock profiles (full/eco/quiet) with hw-limit clamping, desired-profile store (write-through to desired-state.json), `cc-clock` sudoers-scoped helper + installer, caps pushed via `welcome`/`config-update`, caps-aware agent reconcile (boot re-apply), thermal guard (auto-derate w/ hysteresis + event ring), timezone schedules (30s evaluator), energy accounting (kWh/cost from 1m power leaves — **0.4487 kWh measured live over 24 h**), Node Power card + Energy page.

### Remaining

- **M5 (4/10):** `tests: power/clocks ≥75% coverage` (power dir already at 95.88% — needs only a coverage-report check), `M5 gate: reboot reconcile + thermal trigger + spark-only 409` (reboot reconcile + spark-only are unit-proven; live sudo install pending the manual step below).
- **M6 Observability** — alert rules engine, lifecycle, delivery, fabric panel, benchmarks-as-jobs, Alerts/Fleet/Energy pages.
- **M7 Hardening** — config export/import, retention/WAL checkpoint, Settings pages, agent upgrade job, RUNBOOKS + API docs, Playwright e2e, semver v1.0.0.
- **M8 Chat UI** — chat store, SSE proxy over served-models, folder-as-project context, image attachments.

## Live stack topology (as deployed on dgx-1)

- **Dashboard runs via `docker compose up -d --build`** on port **5566** (5555 is banned — sparkControl uses it). Bind mount `./config/` holds all durable state: `nodes.json`, `desired-state.json`, `serve-recipes.json`, `serve-deployments.json`, `served-models.json`, `clients.json`, `clock-profiles.json`, `clock-schedules.json`, `thermal-state.json`, `controlcenter.db`.
- **dgx-1 (this machine)** runs its agent **bare-metal**: `nohup node agent/dist/agent.mjs run`, config `~/.controlcenter/agent/config.json` → `http://127.0.0.1:5566`. Rebuild the bundle after agent changes: `npm run build:agent` then restart the process.
- **dgx2** runs the agent from `~/.local/cc-agent/agent.mjs` via its bundled node (`./node/bin/node`), dashboardUrl points at dgx-1's tailscale IP `100.95.7.60:5566`. Deploy a rebuilt bundle: `scp agent/dist/agent.mjs` over there.
- **modelctl** runs in the dashboard container via bind mounts at identical host paths (`~/.local/share/uv/tools/modelctl`, `~/.local/bin/modelctl`, `~/.config/modelctl`, `/mnt/nas:ro`, `~/.ssh:ro`); `CC_SSH_IDENTITY=/home/piresbruno/.ssh/id_ed25519`.
- Web UI in dev: `npm run dev:web` (:5173, proxies `/api`); the compose container serves the API/WS only.

## First things to do on a new machine

1. `npm install` then `npm run build` (tsc) and `npm test` — expect 285 passing, ~86% coverage.
2. `docker compose up -d --build` — the `config/` directory must be restored from backup (it IS the deployment state).
3. Agents: restart both per the topology above; they self-adopt server config from `welcome`/`config-update`.
4. **Manual (one-time, needs sudo on the node)** — the clock apply path requires the sudoers-scoped helper. From the dashboard: `PUT /api/power/clocks/:sparkId` stores the desire, but the agent can only apply after installing the helper. Generate instructions: dispatch job kind `clock-install` (job `argv` embeds them), or run on the node:
   ```bash
   # helper (from server/src/power/helper.ts CLOCK_HELPER_SCRIPT) → /usr/local/bin/cc-clock (0755)
   echo '<user> ALL=(root) NOPASSWD: /usr/local/bin/cc-clock' | sudo tee /etc/sudoers.d/cc-clock
   sudo chmod 0440 /etc/sudoers.d/cc-clock
   ```
   (sudoers is validated via `visudo -cf` by the automated installer when passwordless sudo exists.)
5. Verify: `curl :5566/api/health`, `/api/nodes`, `/ws` shows both DGXs `consistent`, `/api/power/energy` counts real watts.

## Conventions

- Commits: `git -c core.hooksPath=.githooks commit` (never bare commit). Task IDs `CC-<n>`; roadmap = PLAN.md M0–M8.
- Every task: build + `npm run test:coverage` (c8 ≥75% lines, CI-enforced) + `.agentic/bin/validate` before committing.
- Real verification is mandatory for gate claims — docker compose + curl against the live fleet.
- Port 5566 everywhere (5555 banned). Sudoers is scoped to exactly `/usr/local/bin/cc-clock`; CPU caps must write `scaling_max_freq` (writing `max_perf` reverts on GB10 — verified).
- Test seams in `buildApp({...})` make every adapter injectable; recipes stay user-owned (ADR-0005 — never generate serve commands).
