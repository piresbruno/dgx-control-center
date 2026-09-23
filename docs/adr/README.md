# ADR index

Decisions follow the [template](template.md). Status values: Proposed, Accepted, Rejected, Deprecated, Superseded.

| Decision | Status | Notes |
|---|---|---|
| [ADR-0001](0001-typescript-fastify-monorepo.md) — TypeScript everywhere, Fastify server | Accepted | One toolchain across server/agent/web |
| [ADR-0002](0002-agent-only-runtime-transport.md) — Agent-only runtime transport; SSH = bootstrap/repair only | Accepted | Single writer per data path (F1a) |
| [ADR-0003](0003-local-file-backed-sqlite.md) — Local file-backed SQLite from day one | Accepted | better-sqlite3, WAL, config volume |
| [ADR-0004](0004-native-gateway-router.md) — Native gateway router; llama-swap superseded for fleet traffic | Accepted | Per-client keys + telemetry owned here |
| [ADR-0005](0005-recipes-stay-user-owned.md) — Recipes stay user-owned; dashboard supervises, never generates | Accepted | Dispatch-verb supervision |
| [ADR-0006](0006-clock-actuators.md) — Clock actuators via spark-clock helper (-lgc + max_perf) | Accepted | sudoers-scoped, DGX-only |
| [ADR-0007](0007-rest-and-ws.md) — REST + WS (no tRPC/gRPC) | Accepted | OpenAPI from zod, observable contracts |
| [ADR-0008](0008-pulse-design-system.md) — Pulse DS — bespoke tokens on Tailwind v4 + Radix/shadcn | Accepted | Approved option: Slate Pro |
