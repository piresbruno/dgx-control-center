# ADR-0001: TypeScript everywhere, Fastify server

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** server, agent, web
- **Tags:** stack, language
- **Supersedes:** None
- **Superseded by:** None

## Context

ControlCenter spans three runtime surfaces: HTTP control plane, per-node agent, and web app. Prior art: sparkControl (Express 5 + JS collectors/proxy logic, proven in production), modelctl (Python). One maintainer.

## Decision drivers

- One maintainer: a single toolchain and shared contracts beat per-surface optimal choices.
- Node functionality must be consistent across server/agent (F1a) — shared types are the cheapest enforcement.
- Proven JS collector/proxy logic exists and should be ported, not rewritten.

## Considered options

### Option 1 — TypeScript monorepo with Fastify (selected)

One language for all three surfaces; zod schemas in `shared/` compile-checked everywhere; Fastify 5 on Node 22 brings schema-validated routes, plugin DI, and better throughput than Express 5.

### Option 2 — Go server + Go agent

Single-binary agents and strong concurrency, but two toolchains and materially slower dashboard iteration for a solo project; the web stays TypeScript regardless.

### Option 3 — Python (FastAPI)

Closest to modelctl, strong async, but duplicates the entire agent/WS/proxy investment in a second language and splits contracts.

## Decision

TypeScript (strict) across `server/`, `agent/`, `web/`, with a shared `shared/` package (zod). Server framework: Fastify 5 on Node 22.

## Consequences

### Positive

- Shared contracts are compile errors, not runtime surprises (F1a contract-first).
- sparkControl collector/proxy logic ports near-verbatim.

### Negative

- Agent is a Node bundle (needs Node ≥22 on nodes) rather than a static binary.

### Risks and mitigations

- Node runtime bootstrap on nodes → installer job ships a Node tarball when missing (RUNBOOKS §1).

## Implementation and validation

Workspace skeleton with strict `tsconfig` project references; CI runs typecheck + lint + vitest + build on every push (`.github/workflows/ci.yml`).

## Revisit triggers

- Agent bundle size or Node-tarball bootstrap becomes the dominant operational pain → evaluate a Go agent behind the same protocol (ADR-0002 unaffected).

## References

- PLAN.md §5 F1a, §6 ADR seeds, §10 framework debate
- docs/adr/0002 (transport), docs/adr/0007 (API style)
