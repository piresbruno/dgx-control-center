# ADR-0007: REST + WS (no tRPC/gRPC)

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** server, web, agent
- **Tags:** api, protocol
- **Supersedes:** None
- **Superseded by:** None

## Context

Two API audiences: external AI clients (OpenAI-compatible) and the browser/agent pair needing push. Contracts must stay observable (curl-able, documented).

## Decision drivers

- The gateway itself is REST by ecosystem requirement.
- Browser needs live pushes; agent needs a duplex channel.
- OpenAPI docs generated from the same zod schemas that validate runtime.

## Considered options

### Option 1 — REST + two WS channels (selected)

REST under `/api` (+ gateway `/v1`), browser WS hub, agent WS channel — all validated by `shared/` schemas.

### Option 2 — tRPC/gRPC

Strong typing, but weak curl-ability, extra codegen, and no benefit for OpenAI-compatible externals.

## Decision

Option 1.

## Consequences

### Positive

- Contract tests straight from zod; OpenAPI for free; debuggable with curl.

### Negative

- Hand-rolled WS protocol versioning (covered by `proto` + capability flags).

### Risks and mitigations

- Protocol drift: `PROTOCOL_VERSION` + version floor handshake (ADR-0002).

## Implementation and validation

Health endpoint + contract tests at M0; WS hub lands M1 with handshake matrix tests.

## Revisit triggers

- A second server implementation or non-TS consumer requiring generated stubs.

## References

- PLAN.md §7 API surface, docs/adr/0001, docs/adr/0003
