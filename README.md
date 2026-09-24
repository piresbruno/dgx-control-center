# ControlCenter

Control plane for a home LocalAI infrastructure — 2× DGX Spark (GB10) + QNAP NAS model store: recipe-based serving of multiple models, an OpenAI-compatible gateway with per-client/per-request telemetry, full-fleet metrics, and DGX power/clock management.

- **Plan:** [PLAN.md](./PLAN.md) — vision, feature specs (F1–F8), ADR seeds, milestone roadmap (M0–M8)
- **Decisions:** [docs/adr/](./docs/adr/) — ADR-0001 … ADR-0008
- **Design:** [design/mockups/design-system.html](./design/mockups/design-system.html) — Pulse DS (approved: Slate Pro, light-first, mobile-first) + page mockups
- **Runbooks:** [docs/RUNBOOKS.md](./docs/RUNBOOKS.md)

## Layout

| Package | Purpose |
|---|---|
| `shared` | zod contracts: WS protocol, API types, domain enums (contract-first, ADR-0002/0007) |
| `server` | Fastify control plane: REST, WS hub, gateway, supervisor, metrics, stores |
| `agent` | Per-node daemon (outbound WS, sole runtime transport; SSH = bootstrap/repair) |
| `web` | React 19 + Vite SPA on the Pulse design system |

## Status

**56/92 roadmap tasks done — M0–M4 complete (gates passed on real hardware), M5 in progress.** See [docs/DEVELOPMENT_STATUS.md](./docs/DEVELOPMENT_STATUS.md) for the exact pick-up-elsewhere note, and [PLAN.md](./PLAN.md) for the full roadmap with recorded gate outcomes.

| Milestone | State |
|---|---|
| M0 Bootstrap | ✅ done |
| M1 Fleet Core (metrics, agents, rollups) | ✅ done — gate passed on real DGX1+DGX2 |
| M2 Model Plane (modelctl, remote jobs, Models UI) | ✅ done — gate passed (download→sync→visible on NAS+DGX) |
| M3 Serving (recipes, supervisor, Serve UI) | ✅ done — gate: lifecycle + orphan recovery verified live |
| M4 Gateway & Analysis (router, keys, traces) | ✅ done — gate: live keyed routing + failover drill |
| M5 Power & Clocks | 🔶 6/10 — profiles/thermal/schedules/energy done + live-verified; web done; gate partially recorded |
| M6–M8 | ⬜ pending |

CI-enforced gates: `tsc -b` + vitest (285 tests) + c8 lines ≥75% (actual ~86%).

## Development

```bash
npm install
npm run dev:server   # Fastify on :5566
npm run dev:web      # Vite on :5173 (proxies /api)
npm test             # vitest (c8 gate ≥75% from M1)
npm run typecheck    # tsc -b + web noEmit
npm run lint         # eslint
```
