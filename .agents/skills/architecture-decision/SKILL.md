---
name: architecture-decision
description: Create, review, index, or supersede an architecture decision record when a durable cross-cutting decision is required.
---

# Architecture Decision

## Use this skill when

- A change affects multiple components or teams.
- A decision changes data ownership, security boundaries, deployment, foundational dependencies, or integrations.
- The user asks why an architectural choice exists.
- An accepted decision needs to be replaced.

Do not use it for routine refactors or local implementation details.

## Workflow

1. Read `docs/adr/README.md`; do not load every ADR.
2. Select and read only ADRs relevant to the current scope or tags.
3. Determine the next unused four-digit ID.
4. Copy `docs/adr/template.md` to `docs/adr/NNNN-short-title.md`.
5. Record context, drivers, genuine alternatives, consequences, risks, validation, and revisit triggers.
6. Add the record to the index while it is `Proposed`.
7. Obtain the required human decision before marking it `Accepted`.
8. To replace an accepted decision, create a new ADR and cross-link it with the old record marked `Superseded`.
9. Run `.agentic/bin/validate`.

Accepted ADRs are historical records. Do not rewrite them to make later choices look original.
