# ADR-0004: Native gateway router; llama-swap superseded for fleet traffic

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** server, gateway
- **Tags:** gateway, serving
- **Supersedes:** None
- **Superseded by:** None

## Context

llama-swap currently provides model→server on-demand routing. ControlCenter must own per-client API keys, per-request telemetry (TTFT/ITL/tokens/payloads), placement pre-checks, and fallback chains — integration llama-swap cannot expose.

## Decision drivers

- Client identity is required for per-client aggregation (F4).
- One telemetry pipeline for proxied + internal traffic.
- Avoid double-proxy latency and split-brain routing state.

## Considered options

### Option 1 — Native router in the server (selected)

One OpenAI-compatible `/v1` endpoint: alias→deployment routing (healthy-first, fallback chains), on-demand spin-up/idle-stop (llama-swap parity), per-client keys, capture in-process.

### Option 2 — Proxy to llama-swap

Faster to ship, but double-proxy hop, no client identity in traces, and placement checks stay outside the router.

## Decision

Native router (Option 1). llama-swap may remain installed standalone but leaves the fleet traffic path at M4.

## Consequences

### Positive

- Unified auth, telemetry, and placement in one component.

### Negative

- Swap lifecycle (~1 module) becomes owned code.

### Risks and mitigations

- SSE fidelity regressions: byte-fidelity pass-through tests against fake engines (F1a harness).

## Implementation and validation

M4 gate: reproduce the llama-swap model set as served-models; two keyed clients; failover drill; per-client charts populated.

## Revisit triggers

- If native on-demand behavior cannot match llama-swap for some engine class, run both with a documented exception.

## References

- PLAN.md §5 F4, docs/adr/0005, docs/adr/0007
