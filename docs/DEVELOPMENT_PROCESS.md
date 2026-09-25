# Development Process

## Purpose

Use this workflow for changes to **controlcenter**. Scale the ceremony to the risk and size of the task, but do not skip validation or explicit architectural decisions.

## 1. Understand

- Read the request and acceptance criteria.
- Inspect relevant code and current documentation.
- Identify unknowns, risks, and affected components.
- Confirm assumptions that could materially change the solution.

## 2. Plan

- Create or update a task file from `tasks/task-template.md`.
- Break work into independently verifiable steps.
- Record expected tests and documentation changes.
- Decide whether the task has architectural impact.
- For agent-guided bootstrap maintenance, follow `docs/AGENT_GUIDED.md`; the agent stops after preview and a human applies separately.

## 3. Architecture Decision Check

An ADR is normally required for cross-cutting, durable, security-sensitive, data-model, deployment, foundational dependency, or external integration decisions.

If required:

1. Read `docs/adr/README.md`.
2. Load only relevant ADRs.
3. Copy `docs/adr/template.md` to the next available four-digit ID.
4. Complete options, consequences, validation, and revisit triggers.
5. Add the proposed ADR to the index.
6. Obtain the required decision approval before treating it as Accepted.

Routine refactors and local implementation details do not require ADRs.

## 4. Implement

- Keep the change focused and consistent with established patterns.
- Avoid unrelated cleanup.
- Keep one writer for overlapping files when agents are used.
- For changes under `web/src/`, follow `docs/DESIGN_SYSTEM.md`: compose `pulse.css` classes and the `web/src/ui` primitives instead of authoring page-level CSS.
- Never hide failures by weakening tests or security controls.

## 5. Validate

Run applicable commands:

```bash
.agentic/bin/validate
npm test
npm run build
.agentic/bin/docs-check
```

Skip commands marked “Not configured”; record the missing configuration instead of executing that text.

## 6. Review

Review the diff for correctness, security, compatibility, test coverage, documentation, and unnecessary complexity. Update the task file with evidence and residual risks.

## 7. Complete

- Ensure acceptance criteria are met.
- Ensure new or superseding ADRs are indexed and linked.
- Confirm generated configuration still validates.
- Provide a concise summary of changes, validation, and remaining risks.
- For a version bump or release, follow `docs/RELEASING.md` with the `semantic-versioning` skill; obtain explicit confirmation before creating the release commit or tag.
