---
name: docs-check
description: Check whether code, configuration, architecture, or integration changes need corresponding documentation or ADR updates.
---

# Documentation Check

Run `.agentic/bin/docs-check` and review its bounded heuristic report.

## Review manually

- Public behavior and interfaces
- Configuration and environment variables
- Architecture, data ownership, deployment, and integrations
- Setup and operational procedures
- ADR requirements or supersession
- The progressive-disclosure index in `AGENTS.md`

For architecture changes, read `docs/adr/README.md` first and then only relevant ADRs. Do not pre-load the entire ADR directory.

The checker is evidence, not proof that documentation is complete. Report uncertainty and residual gaps.
