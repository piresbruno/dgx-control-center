# ControlCenter

Control plane for a home LocalAI infrastructure — 2× DGX Spark (GB10) + QNAP NAS model store: recipe-based serving of multiple models, an OpenAI-compatible gateway with per-client/per-request telemetry, full-fleet metrics, and DGX power/clock management.

- **Plan:** [PLAN.md](./PLAN.md) — vision, feature specs (F1–F8), ADR seeds, milestone roadmap (M0–M7)
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

M0 — repository bootstrapped (agentic-bootstrap), workspace skeleton with health contract, CI, hooks, ADRs. Next: M1 Fleet core (`shared` protocol + `FakeNode`/`--fake-fleet` harness first).

## Development

```bash
npm install
npm run dev:server   # Fastify on :5555
npm run dev:web      # Vite on :5173 (proxies /api)
npm test             # vitest (c8 gate ≥75% from M1)
npm run typecheck    # tsc -b + web noEmit
npm run lint         # eslint
```
