# ADR-0003: Local file-backed SQLite from day one

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** server
- **Tags:** storage, persistence
- **Supersedes:** None
- **Superseded by:** None

## Context

Homelab deployment (2× DGX + QNAP). Owner requirement: persistence on the local filesystem to start, no external DB services. Workloads: request traces, telemetry rollups, energy, jobs, alerts — write-heavy, single-process.

## Decision drivers

- Zero-ops reliability; backup must be a file copy.
- Single-process server ⇒ embedded DB is sufficient and race-free.

## Considered options

### Option 1 — SQLite via better-sqlite3, WAL (selected)

One `.db` file under the config volume; synchronous API suits Node; WAL handles concurrent readers; migrations via a version table.

### Option 2 — Postgres

Overkill server ops for a homelab appliance.

### Option 3 — DuckDB

Columnar analytics engine; wrong write pattern for high-frequency telemetry inserts.

## Decision

better-sqlite3 (WAL) from day one for all state + telemetry; JSON config files via `atomicWrite` for user-editable registries.

## Consequences

### Positive

- No services to run; survives restarts and container rebuilds (volume).

### Negative

- Scale ceiling far away but real (fine for homelab; retention + rollups manage growth).

### Risks and mitigations

- Corruption/lockups: WAL + checkpointing + backup runbook (RUNBOOKS §5).

## Implementation and validation

`CC_DB_PATH` env (default `config/controlcenter.db`) parsed by typed env schema at M0; stores land at M1 with migration tests.

## Revisit triggers

- Multi-instance server or analytics beyond SQLite's write pattern.

## References

- PLAN.md §3 Stores, §5 F5, docs/adr/0007
