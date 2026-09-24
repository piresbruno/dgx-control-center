# Development Status — pick-up-elsewhere note

_Last updated: 2026-09-24. Branch `main`. 305 tests, ~84 % lines coverage (gate 75 %), `.agentic/bin/validate` green, Playwright e2e green on the fake fleet._

## Where we are

**M0–M6 complete, M7 7/8 (gate PASSED), M8 Chat UI pending.** 83/92 roadmap tasks done. Gate outcomes are recorded inline in PLAN.md under each milestone. The only blocked item is the release tag: **v1.0.0 is deferred by owner decision until M8 lands** (release config documented in `docs/RELEASING.md`; CHANGELOG prepared with a dated 0.1.0 section).

### Done and verified on real hardware

- **M1 Fleet Core** — agent WebSocket hub, live metrics (cpu/gpu/memory/network/storage), SQLite 1m/1h/1d rollups, node directory, desired-state reconciler, Overview/Node pages. Both DGXs report `consistent` via `/ws`.
- **M2 Model Plane** — modelctl service (TTL caches, stale-serve), remote job channel (`job-run/out/exit`), placement planner, modelctl provisioning over SSH, Models page (catalog/presence/download queue). Gate: download → sync → visible on NAS+DGX.
- **M3 Serving** — recipe registry + probe (verbs, `.env` public keys, secret presence-only, container scrape, git drift), deployment supervisor + 10-state join, multi-node exact-delta guard, VRAM/UMA budget estimator, Serve/Recipes pages, per-node pass-through `/llm/node/:id/:port/*`. Gate: scratch-engine lifecycle + orphan recovery after dashboard restart; GLM TP=2 deployed from the UI.
- **M4 Gateway & Analysis** — served-models router (healthy-first chains, round-robin), `/v1` gateway with hashed client keys/scopes, request recorder (TTFT/ITL/tokens), SQLite traces, aggregations, Prometheus + CSV, Analysis/Clients/Router pages. Gate: keyed routing to the real GLM engine + 502 failover drill.
- **M5 Power & Clocks** — clock profiles (full/eco/quiet) with hw-limit clamping, `cc-clock` sudoers-scoped helper + installer, caps pushed via `welcome`/`config-update`, boot re-apply, thermal guard, timezone schedules, energy accounting (0.4487 kWh / 24 h measured), Node Power card + Energy page. Live clock apply awaits the one-time sudoers install (manual two-line step; see RUNBOOKS).
- **M6 Observability** — alert rules engine + lifecycle + delivery (WS toast, webhooks), fabric panel, benchmarks-as-jobs, Alerts/Fleet/Energy pages. Gate: pulled-agent alert fired→resolved live; kWh rollups from real watts.
- **M7 Hardening & Release (7/8)** — config export/import + backup tooling, retention enforcement + WAL checkpointing, Settings pages (capture/retention/origins/tokens/maintenance), version-floor agent upgrade job + capability sweep, RUNBOOKS complete + generated API reference (`/api/openapi.json`), **Playwright e2e suite on the fake fleet (5 specs, `npm run test:e2e`)**, and the **M7 gate: fresh-machine install from README to first request = 9 m 0 s** (budget 30 min; evidence in PLAN.md M7).

### Remaining

- **M8 Chat UI (7+1 tasks)** — chat store (conversations/folders/messages/attachments in SQLite), chat completions proxy over served-models with SSE streaming, folder-as-project context injected into prompts, image attachments + vision-capable routing, Chat page (list/folders/streaming markdown), tests ≥75 % coverage, M8 gate (chat end-to-end + folder context persisted).
- **Release (blocked)** — v1.0.0 tag via the `semantic-versioning` skill, to run after M8 lands.

## Live stack topology (as deployed on dgx-1)

- **Dashboard runs via `docker compose up -d --build`** on port **5566** (5555 is banned — sparkControl uses it). Bind mount `./config/` holds all durable state: `nodes.json`, `desired-state.json`, `serve-recipes.json`, `serve-deployments.json`, `served-models.json`, `clients.json`, `clock-profiles.json`, `clock-schedules.json`, `thermal-state.json`, `settings.json`, `controlcenter.db`.
- **dgx-1 (this machine)** runs its agent **bare-metal** with the repo's bundled node: `setsid sh -c 'cd ~/developer/controlcenter && exec node agent/dist/agent.mjs run >> /tmp/agent-dgx1.log 2>&1 < /dev/null' &`, config `~/.controlcenter/agent/config.json` → `http://127.0.0.1:5566`. Rebuild the bundle after agent changes: `npm run build:agent` then restart the process.
- **dgx2** runs the agent from `~/.local/cc-agent/agent.mjs` via its bundled node (`~/.local/cc-agent/node/bin/node`), dashboardUrl `http://100.95.7.60:5566`. Deploy a rebuilt bundle: `scp agent/dist/agent.mjs dgx2:~/.local/cc-agent/` then restart. **Run exactly ONE agent per sparkId** — a duplicate connection replaces the old socket (eviction storm; ledger of past incidents in RUNBOOKS).
- **modelctl** runs in the dashboard container via bind mounts at identical host paths (`~/.local/share/uv/tools/modelctl`, `~/.local/bin/modelctl`, `~/.config/modelctl`, `/mnt/nas:ro`, `~/.ssh:ro`); `CC_SSH_IDENTITY=/home/piresbruno/.ssh/id_ed25519`. Its model roots are **HOME-relative** — isolated-HOME agent drills must expose `~/.config/modelctl`.
- **Serving state on the fleet**: the GLM TP=2 deployment is stopped (containers removed) — start it from the Serve page when needed. A working **qwen3-0.6b recipe** lives on dgx2 at `~/recipes/qwen3-0.6b` (start/stop/status + `.env`; vLLM OpenAI image `vllm/vllm-openai:qwen38-flash-next`, cache volume `cc-qwen-cache` for ~40 s warm boots). The README quickstart reproduces it.
- Web UI in dev: `npm run dev:web` (:5173, proxies `/api` **and `/ws`**); the compose container serves the API/WS only.

## First things to do on a new machine

1. `npm install` then `npm run build` (tsc) and `npm run test:coverage` — expect **305 passing, ~84 % lines**.
2. `npm run test:e2e` (Playwright; boots its own fake-fleet API + Vite on scratch ports 5599/5199).
3. `docker compose up -d --build` — restore `config/` from backup for existing state, or seed `config/nodes.json` fresh (see README quickstart; `createdAt` is required).
4. Agents: start both per the topology above; they self-adopt server config from `welcome`/`config-update`.
5. **Manual (one-time, needs sudo on the node)** — clock apply requires the `cc-clock` helper + sudoers entry; instructions in RUNBOOKS.md and `docs/DEVELOPMENT_STATUS.md` history.
6. Continue with **M8 Chat UI** (next task: server chat store), then the release tag.

## Ops notes learned the hard way

- `pkill -f <pattern>` over SSH **self-matches the remote shell** when the pattern appears in the same command line — split kill and start into separate SSH invocations, or use a regex-class trick (`cc-gate[-]home/agent`).
- `nohup … &` over SSH keeps the session open (holds the channel); use `setsid sh -c 'exec … < /dev/null' & disown`.
- Long-running LLM boots: vLLM on GB10 (sm_121) pays a one-time JIT/autotune cost (~4 min); mount a cache volume into the container to keep warm boots ~40 s.
- Check `docker ps -a` and unified-memory pressure on a node before blaming the supervisor when a deployment fails to start — a stale TP=2 worker can hold >100 GiB.
