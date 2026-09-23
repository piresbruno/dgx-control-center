# ADR-0002: Agent-only runtime transport; SSH = bootstrap/repair only

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** server, agent
- **Tags:** transport, resilience
- **Supersedes:** None
- **Superseded by:** None

## Context

sparkControl ran two parallel node implementations (SSH collectors + agent push) behind a "parity rule". Result: inconsistent freshness and shapes, divergent behavior, and nodes that appeared half-alive. The owner requires a resilient, consistent node plane.

## Decision drivers

- One writer per data path — consistency by construction, not by parity testing.
- Loopback-bound engines (127.0.0.1:8888) are invisible over SSH but trivial for an in-node agent.
- Degraded-but-honest beats silently-stale.

## Considered options

### Option 1 — Agent-only runtime; SSH repairs (selected)

The agent (outbound WS) is the only runtime transport for metrics, probes, jobs, and serving supervision. SSH installs/repairs the agent and serves read-only probes on declared-limited nodes (NAS). Unhealthy agent ⇒ node explicitly `offline`/`degraded` (F1a enum), with a node-down alert (F5a) and an SSH re-install job.

### Option 2 — Keep dual transport with parity tests

Preserves SSH metrics fallback, but every feature is implemented twice and freshness/shape drift keeps recurring; parity tests only prove the tested slice.

## Decision

Agent-only runtime transport (Option 1), with systemd `Restart=always` + watchdog, sequenced atomic snapshots, and local reconcile so the node survives dashboard loss.

## Consequences

### Positive

- Eliminates the dual-implementation bug class; one protocol, one code path.
- Push cadence + in-node probes enable loopback engine telemetry.

### Negative

- Node visibility depends on agent health.

### Risks and mitigations

- Agent death ⇒ blind node: systemd restart + watchdog, SSH auto-repair job, node-down alert (F5a), declared `degraded` state — never silent.

## Implementation and validation

`agent/` bundle + `/agent-ws` handshake (proto + version floor); M1 gate proves fault injection on `FakeNode` (kill agent → `degraded`, replay with gap markers, reconciler re-apply after simulated boot).

## Revisit triggers

- Repeated agent bootstrap failures on a node class (e.g. locked-down NAS) → formalize the `limited` probe profile further.

## References

- PLAN.md §3 Transport rules, §5 F1a
- docs/adr/0008 (UX surfaces the state enum), docs/RUNBOOKS.md §1
