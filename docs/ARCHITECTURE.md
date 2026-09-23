# Architecture

## Purpose

This document is the current high-level map of **controlcenter**. Keep it concise. Detailed historical rationale belongs in `docs/adr/`.

## System Context

Not configured. Document users, external systems, trust boundaries, and primary responsibilities when known.

## Components

Not configured. List major components and their responsibilities without duplicating source-level details.

## Data and State

Not configured. Document authoritative stores, ownership, retention, and migration constraints when applicable.

## Integrations

Not configured. Document external protocols, failure boundaries, and credential ownership when applicable.

## Deployment and Operations

Not configured. Document deployment units, environments, observability, and recovery expectations when applicable.

## Agent-Guided Maintenance Boundary

When the agent-guided bootstrap workflow is used, repository evidence and agent proposals are untrusted. The deterministic core owns rendering, planning, apply, rollback, and validation. The agent stops after preview; a human separately confirms the recomputed plan in an interactive terminal. See `docs/AGENT_GUIDED.md`.

## Architecture Decision Index

Read `docs/adr/README.md` before individual decision records. Update this overview when an accepted ADR changes the current architecture.
