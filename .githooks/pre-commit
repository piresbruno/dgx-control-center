#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

echo "Running agentic project validation..."
.agentic/bin/validate

if command -v gitleaks >/dev/null 2>&1; then
  echo "Running gitleaks against staged changes..."
  gitleaks protect --staged --redact
else
  echo "gitleaks not installed; skipping optional credential scan"
fi

.agentic/bin/docs-check

read_configured_command() {
  python3 - "$1" <<'PY'
import json
import sys
from pathlib import Path
config = json.loads(Path('.agentic/config.json').read_text(encoding='utf-8'))
value = config.get('project', {}).get('commands', {}).get(sys.argv[1])
if isinstance(value, str) and value.strip():
    print(value)
PY
}

TEST_COMMAND="$(read_configured_command test)"
BUILD_COMMAND="$(read_configured_command build)"

if [[ -n "$TEST_COMMAND" ]]; then
  echo "Running configured tests"
  bash -lc "$TEST_COMMAND"
fi
if [[ -n "$BUILD_COMMAND" ]]; then
  echo "Running configured build"
  bash -lc "$BUILD_COMMAND"
fi
