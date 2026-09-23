#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

FORCE=false
if [[ "${1:-}" == "--force" ]]; then
  FORCE=true
fi

CURRENT="$(git config --get core.hooksPath || true)"
if [[ -n "$CURRENT" && "$CURRENT" != ".githooks" && "$FORCE" != true ]]; then
  echo "Existing core.hooksPath is '$CURRENT'. Refusing to replace it."
  echo "Integrate .githooks/pre-commit manually or rerun with --force."
  exit 2
fi

chmod +x .githooks/pre-commit .agentic/bin/validate .agentic/bin/docs-check
git config core.hooksPath .githooks
echo "Git hooks configured at .githooks"
