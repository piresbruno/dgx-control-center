# Development Status — pick-up-elsewhere note

_Last updated: 2026-09-26. Branch `main`. 348 tests, ~85 % lines coverage (gate 75 %), `.agentic/bin/validate` green, Playwright e2e (11 tests incl. the mock-seam and mobile-nav guards) green on the fake fleet._

## Where we are

**M0–M8 complete — every milestone gate passed on the real fleet, and v1.0.0 is released and tagged.** All 92 roadmap tasks are done (`PLAN.md` has no open items); tag `v1.0.0` exists (`d636a60`). The roadmap is exhausted — new work starts from user direction, not the plan. Gate outcomes are recorded inline in PLAN.md under each milestone.

### Done and verified on real hardware

- **M1 Fleet Core** — agent WebSocket hub, live metrics (cpu/gpu/memory/network/storage), SQLite 1m/1h/1d rollups, node directory, desired-state reconciler, Overview/Node pages. Both DGXs report `consistent` via `/ws`.
- **M2 Model Plane** — modelctl service (TTL caches, stale-serve), remote job channel (`job-run/out/exit`), placement planner, modelctl provisioning over SSH, Models page (catalog/presence/download queue). Gate: download → sync → visible on NAS+DGX.
- **M3 Serving** — recipe registry + probe (verbs, `.env` public keys, secret presence-only, container scrape, git drift), deployment supervisor + 10-state join, multi-node exact-delta guard, VRAM/UMA budget estimator, Serve/Recipes pages, per-node pass-through `/llm/node/:id/:port/*`. Gate: scratch-engine lifecycle + orphan recovery after dashboard restart; GLM TP=2 deployed from the UI.
- **M4 Gateway & Analysis** — served-models router (healthy-first chains, round-robin), `/v1` gateway with hashed client keys/scopes, request recorder (TTFT/ITL/tokens), SQLite traces, aggregations, Prometheus + CSV, Analysis/Clients/Router pages. Gate: keyed routing to the real GLM engine + 502 failover drill.
- **M5 Power & Clocks** — clock profiles (full/eco/quiet) with hw-limit clamping, `cc-clock` sudoers-scoped helper + installer, caps pushed via `welcome`/`config-update`, boot re-apply, thermal guard, timezone schedules, energy accounting (0.4487 kWh / 24 h measured), Node Power card + Energy page. Live clock apply awaits the one-time sudoers install (manual two-line step; see RUNBOOKS).
- **M6 Observability** — alert rules engine + lifecycle + delivery (WS toast, webhooks), fabric panel, benchmarks-as-jobs, Alerts/Fleet/Energy pages. Gate: pulled-agent alert fired→resolved live; kWh rollups from real watts.
- **M7 Hardening & Release (7/8)** — config export/import + backup tooling, retention enforcement + WAL checkpointing, Settings pages (capture/retention/origins/tokens/maintenance), version-floor agent upgrade job + capability sweep, RUNBOOKS complete + generated API reference (`/api/openapi.json`), **Playwright e2e suite on the fake fleet (5 specs, `npm run test:e2e`)**, and the **M7 gate: fresh-machine install from README to first request = 9 m 0 s** (budget 30 min; evidence in PLAN.md M7).

### Remaining (optional, ops-only)

- **Live clock apply** needs the one-time `cc-clock` sudoers install on a node (manual two-line step; documented in RUNBOOKS).
- **GLM TP=2 deployment is parked** (containers removed) — start it from the Serve page when wanted.

Proxy body limits: gateway `/v1/*` and the chat message route share `PROXY_BODY_LIMIT_BYTES` (48 MiB, `server/src/proxyBodyLimit.ts`) so base64 image payloads are rejected by the handler, not by Fastify's 1 MiB default (which closed the socket mid-upload — clients saw EPIPE instead of 413).

### M8 Chat UI (done, gate passed)

- Surface: `/api/chat/folders`, `/api/chat/conversations` (+detail), `/api/chat/models`, `/api/chat/attachments/:id`, and `POST /api/chat/conversations/:id/messages` (SSE; `{stream:false}` returns buffered JSON).
- Proxy: reuses the gateway router (health ranking, failover, on-demand spin-up) with client identity `dashboard-chat`; forwards engine SSE chunks verbatim and appends an `event: cc-meta` frame (message ids, status, ttft, duration, usage).
- Context: the conversation's folder description becomes a leading `system` message; images become `image_url` content parts replayed from SQLite on later turns; images are refused (`400` + `visionAliases`) unless the conversation's alias is marked `vision` (set it via `POST /api/gateway/served-models {vision:true}`).
- Live gate evidence (2026-09-24): `qwen3-0.6b` on dgx2 served via the real supervisor; streamed answer used a fact that existed only in the folder description (`ORION-7`); second turn returned engine usage (`114 in / 48 out`) with `ttft 256 ms`; traces show `dashboard-chat`; folder/description/messages survived a container restart.

### CC-1 Design system + full mock fleet (done, 2026-09-25)

- **Pulse DS**: tokens (`--s1…--s8`, `--ctl-h`, `--bg-2/--fg-2`), global form-control styling (`select` custom chevron), layout utilities and `.form-grid`/`.callout`/`.toolbar`/`.empty` in `pulse.css`; React primitives in `web/src/ui/` (Field, Segmented, Toolbar, Callout, EmptyState, Kpi, DetailList, KeyBlock, DataTable bits); dev-only **/styleguide** page is the live inventory. Contract + hard rules: `docs/DESIGN_SYSTEM.md` (indexed T1 in AGENTS.md when a task touches `web/`).
- **Data seam**: `web/src/api/client.ts` is the only fetch layer; all 13 pages go through `web/src/api/*` domain modules (no raw `fetch` or local `json()` helpers in pages anymore).
- **Mock dataset**: `--fake-fleet` now also seeds every previously-empty surface via `server/src/mockData.ts` — gateway clients + ~40 traces (5xx/slow tails), recipes/deployments with coherent probes, served-models (glm-live vision:true), firing+resolved alerts on real rule ids, 7-day gpu-only energy backfill, a chat conversation — deterministic and idempotent. Zero mock logic in `web/`: dropping the flag yields honest empty states (asserted both ways by `e2e/mock-seam.spec.ts`).
- Fleet-specific copy (`dgx1:8081`, `cc.home.local`, "2× DGX … QNAP") removed from product paths; Overview sub-line and the Router placeholders derive from live data.
- **2026-09-26 review round:** visual review of all pages (light+dark, 1568/390/320) found spacing drift and two mobile-breaking defects, both fixed as CSS contract: `.page`'s flex gap now owns section rhythm (page-level `.mt` deleted), and `.menu-btn`'s base rule moved before the media override (the hamburger was permanently `display:none` on phones). Settings backups table wrapped in `TableScroller`; odd-count KPI rows self-fill; `.col-act` is flex+gap. `docs/DESIGN_SYSTEM.md` gained the hard rules + a "Recurring defect classes" section; `e2e/mobile.spec.ts` guards the drawer flow and 360px overflow. The fleet explorer's blank charts against the seed were fixed too (`gpus.0.*` seed keys + honest empty-series states).

## Live stack topology (as deployed on dgx-1)

- **Dashboard runs via `docker compose up -d --build`** on port **5566** (5555 is banned — sparkControl uses it). Bind mount `./config/` holds all durable state: `nodes.json`, `desired-state.json`, `serve-recipes.json`, `serve-deployments.json`, `served-models.json`, `clients.json`, `clock-profiles.json`, `clock-schedules.json`, `thermal-state.json`, `settings.json`, `controlcenter.db`.
- **dgx-1 (this machine)** runs its agent **bare-metal** with the repo's bundled node: `setsid sh -c 'cd ~/developer/controlcenter && exec node agent/dist/agent.mjs run >> /tmp/agent-dgx1.log 2>&1 < /dev/null' &`, config `~/.controlcenter/agent/config.json` → `http://127.0.0.1:5566`. Rebuild the bundle after agent changes: `npm run build:agent` then restart the process.
- **dgx2** runs the agent from `~/.local/cc-agent/agent.mjs` via its bundled node (`~/.local/cc-agent/node/bin/node`), dashboardUrl `http://100.95.7.60:5566`. Deploy a rebuilt bundle: `scp agent/dist/agent.mjs dgx2:~/.local/cc-agent/` then restart. **Run exactly ONE agent per sparkId** — a duplicate connection replaces the old socket (eviction storm; ledger of past incidents in RUNBOOKS).
- **modelctl** runs **on the nodes** (ADR-0009): the store catalog (`GET /api/models`) dispatches `modelctl list --json` to a store-capable node over the agent job channel; the dashboard container mounts only `./config` + `~/.ssh:ro` (`CC_SSH_IDENTITY=/home/piresbruno/.ssh/id_ed25519`). dgx-1 is the effective store node (store mounted + modelctl configured); register a `kind: nas` store owner to pin selection.
- **Serving state on the fleet** (observed 2026-09-25): `glm53-exl3` TP=2 is **live** — `glm53-exl3-head` on dgx-1:8081 + `glm53-exl3-worker` on dgx2, gateway alias `glm-live`; the supervisor record for that recipe reads `desired=stopped` (containers were started outside the supervisor). qwen3-0.6b (`cc-qwen` on dgx2, alias `qwen-local`) is stopped (clean exit, memory left free for the GLM worker rank); its supervisor record still says `desired=running`.
- Web UI: the compose container serves the **built UI + API + WS on the same port 5566** (`web/dist` via `server/src/staticUi.ts`; API/WS 404s stay JSON). Dev alternative: `npm run dev:web` (:5173, proxies `/api` **and `/ws`** against a locally running API).

## First things to do on a new machine

1. `npm install` then `npm run build` (tsc) and `npm test` — expect **348 passing**.
2. `npm run test:e2e` (Playwright; boots its own fake-fleet API + Vite on scratch ports 5599/5199).
3. `docker compose up -d --build` — restore `config/` from backup for existing state, or seed `config/nodes.json` fresh (see README quickstart; `createdAt` is required — or skip seeding and add nodes from **Settings → Nodes**).
4. Agents: start both per the topology above; they self-adopt server config from `welcome`/`config-update`.
5. **Manual (one-time, needs sudo on the node)** — clock apply requires the `cc-clock` helper + sudoers entry; instructions in RUNBOOKS.md and `docs/DEVELOPMENT_STATUS.md` history.
6. **Roadmap complete** — nothing pending in `PLAN.md`; operations live in `RUNBOOKS.md`, architecture in `docs/ARCHITECTURE.md`.

## Ops notes learned the hard way

- Rejecting a large upload before reading its body (Fastify default `bodyLimit`) closes the socket mid-write: clients get `EPIPE` instead of the status code, and the failure is platform-timing-dependent (passed on dgx-1, failed deterministically on the Mac). Keep route `bodyLimit` above your real payload ceilings and reject in the handler after the body lands.

- `pkill -f <pattern>` over SSH **self-matches the remote shell** when the pattern appears in the same command line — split kill and start into separate SSH invocations, or use a regex-class trick (`cc-gate[-]home/agent`).
- `nohup … &` over SSH keeps the session open (holds the channel); use `setsid sh -c 'exec … < /dev/null' & disown`.
- Long-running LLM boots: vLLM on GB10 (sm_121) pays a one-time JIT/autotune cost (~4 min); mount a cache volume into the container to keep warm boots ~40 s.
- Check `docker ps -a` and unified-memory pressure on a node before blaming the supervisor when a deployment fails to start — a stale TP=2 worker can hold >100 GiB.
