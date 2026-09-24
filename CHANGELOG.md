# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned

- M8 Chat UI: chat store, SSE chat completions proxy, folder-as-project context, image attachments, Chat page.

- Chat UI: chat store (conversations, folders, messages, attachments in SQLite), SSE chat completions proxy over served models, folder-as-project context, image attachments with vision-capable routing, Chat page with streaming markdown.

## [0.1.0] - 2026-09-24

First end-to-end release: fleet telemetry, model plane, recipe-based serving, OpenAI-compatible gateway with per-client telemetry, power/clock management, and full observability — verified on the real 2× DGX Spark + NAS fleet.

### Added

- **Fleet core (M1)** — per-node agents over outbound WebSocket (sole runtime transport; SSH = bootstrap/repair), atomic metric snapshots (cpu/gpu/memory/network/storage), SQLite 1m/1h/1d rollups with WAL, node directory CRUD with token bootstrap, desired-state reconciler, fake-fleet dev mode, Pulse DS web shell with Overview/Node pages.
- **Model plane (M2)** — modelctl integration (NAS + per-node inventories with TTL caches and stale-serve), remote job channel (`job-run/out/exit` with single-flight, kill, boot recovery), placement planner with transfer-capacity math, modelctl/uv validation + provisioning, Models page (catalog, presence matrix, download queue with cancel).
- **Serving (M3)** — user-owned recipe registry + read-only probe (verbs, `.env` public keys, secret presence-only, container scrape, git drift), deployment supervisor with observed-state join (orphan/stopping/foreign/healthy/starting/failed…), multi-node exact-delta guard, VRAM/UMA budget estimator, Serve/Recipes pages, per-node pass-through `/llm/node/:id/:port/*` with SSE.
- **Gateway & analysis (M4)** — served-models router (healthy-first fallback chains, round-robin), OpenAI-compatible `/v1` proxy with hashed per-client API keys + scopes and client-header-wins upstream auth injection, request recorder (TTFT/ITL histograms/tokens), capped + redacted traces store, aggregation queries, Prometheus + CSV export, Analysis/Clients/Router pages.
- **Power & clocks (M5)** — clock profiles (full/eco/quiet) with hw-limit clamping, sudoers-scoped `cc-clock` helper + installer, desired-profile write-through with agent boot re-apply, thermal guard (auto-derate with hysteresis + event ring), timezone-aware schedules, energy accounting (kWh/cost from real GPU watts), Node Power card + Energy page.
- **Observability (M6)** — alert rules engine (node-metric / gateway-5xx / node-unreachable sources with hold windows), full alert lifecycle (firing → acknowledged → resolved, mute windows, re-fire), WS toast + per-severity webhook delivery, alerts/Fleet-explorer pages, fabric probe + benchmark job kinds.
- **Hardening (M7)** — allowlisted config export/import, WAL-checkpointed backups with retention, Settings page, agent version-floor enforcement + capability sweep, RUNBOOKS + generated API reference, Playwright e2e on the fake fleet.

### Gates (verified on the real fleet)

- M1: both DGXs `consistent`, real metric domains, fresh rollups.
- M2: download → sync → visible on NAS + DGX.
- M3: serve lifecycle (register → probe → deploy → start → healthy → stop) + orphan recovery after dashboard restart.
- M4: live keyed routing to the real GLM engine (alias rewrite, usage recorded) + 502 failover drill with attempts trail.
- M5: profile set/restore through the reconciler, real energy telemetry (0.4487 kWh / 24 h), spark-only 409, hysteresis.
- M6: pulled-agent alert fired and auto-resolved after agent restart (bug found and fixed: the tick now samples the node directory).
