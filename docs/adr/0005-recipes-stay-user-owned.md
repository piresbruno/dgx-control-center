# ADR-0005: Recipes stay user-owned; dashboard supervises, never generates

- **Status:** Accepted
- **Date:** 2026-09-23
- **Decision owners:** piresbruno
- **Scope:** serving
- **Tags:** serving, recipes
- **Supersedes:** None
- **Superseded by:** None

## Context

Recipes are user-authored folders with dispatch verbs (`start.sh start|stop|status|logs`), git-versioned, sometimes docker-compose backed (8 real recipes in `~/developer/recipes`).

## Decision drivers

- Engine diversity (vLLM, llama.cpp, SGLang, EXL3, Anemll compose) must be inherited, not modeled.
- Users keep git history and full control of launch semantics.

## Considered options

### Option 1 — Supervise user recipes via their own verbs (selected)

Dashboard registers `(node, path)`, probes entry/verbs/ports/`.env` presence, runs verbs as detached driver jobs, reports state (incl. orphan/foreign/drift).

### Option 2 — Generate serve commands from manifests

Convenient but re-implements each engine's launch matrix and steals ownership from the user's repo.

## Decision

Option 1; script-class runs (library scripts with `MODEL_NAME`/`PORT`/`EXTRA_ARGS` env contract) coexist in the same deployments table.

## Consequences

### Positive

- Zero lock-in; recipes remain portable and reviewable.

### Negative

- Launch bugs live in user scripts; the dashboard can only observe.

### Risks and mitigations

- Divergent verb conventions: probe validates verbs at registration; clear state chips (`orphan`, `drift`).

## Implementation and validation

M3 gate: GLM TP=2 recipe deployed from the UI; two concurrent single-node models; armed-stop + orphan recovery after dashboard restart.

## Revisit triggers

- If recipe onboarding friction dominates, add an optional template generator behind explicit opt-in.

## References

- PLAN.md §5 F3, §2.3 recipe inventory, docs/adr/0004
