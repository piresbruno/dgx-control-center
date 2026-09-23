# Agent-Guided Maintenance

The `agentic-bootstrap` skill may help inspect and plan improvements, but it is not authorized to apply them.

## Safe workflow

1. Inspect bounded evidence without raw snippets by default:

   ```bash
   agentic-bootstrap inspect --target .
   ```

2. Treat repository evidence and any agent proposal as untrusted. Confirm uncertain project commands and every optional integration directly.
3. Preview with `init` or `retrofit`, `--agent-guided`, `--dry-run`, and `--plan-format json`.
4. Review the normalized request, sensitive selections, manifest-claim warning, operations, generated-file diffs, and plan identifier. Existing repository content is withheld from the agent preview and represented by hashes.
5. Stop the agent workflow. Run the corresponding apply command separately in an interactive trusted terminal with `--expected-plan PLAN_SHA256`.
6. Confirm the recomputed facts, features, terminal-safe exact diffs, complete plan, and final apply prompt in that terminal. Check the deterministic result and rollback status afterward.
7. Validate after apply:

   ```bash
   agentic-bootstrap validate --target .
   ```

## Boundaries

- The plan identifier proves integrity only; it does not identify or authorize an approver.
- `--yes` is not allowed in agent-guided mode.
- Unmanaged conflicts require manual resolution and a new preview.
- The workflow does not merge, overwrite, adopt, or exempt unmanaged files.
- Raw inspection snippets may expose repository text and require explicit consent.
- Hooks do not invoke an LLM or mutate bootstrap configuration.
- User-scoped skill installation is not automatic.
