#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def git_names(arguments: list[str]) -> tuple[list[str], str | None]:
    result = subprocess.run(
        ["git", *arguments], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, check=False,
    )
    if result.returncode != 0:
        return [], result.stderr.strip() or f"git {' '.join(arguments)} failed"
    return result.stdout.splitlines(), None


def changed_files(base: str | None) -> tuple[list[str], str | None]:
    if not (ROOT / ".git").exists():
        return [], "not a Git repository"
    collected: list[str] = []
    errors: list[str] = []
    if base:
        names, failure = git_names(["diff", "--name-only", f"{base}...HEAD"])
        collected.extend(names)
        if failure:
            errors.append(failure)
    else:
        names, failure = git_names(["diff", "--name-only"])
        collected.extend(names)
        if failure:
            errors.append(failure)
    staged, staged_failure = git_names(["diff", "--cached", "--name-only"])
    collected.extend(staged)
    if staged_failure:
        errors.append(staged_failure)
    return sorted(set(collected)), "; ".join(errors) if errors else None


def classify(paths: list[str]) -> list[str]:
    findings: list[str] = []
    docs = [path for path in paths if path.lower().endswith(".md")]
    architecture = [
        path for path in paths
        if any(token in path.lower() for token in ("migration", "schema", "database", "deploy", "infra", "integration", "provider", "architecture"))
        and not path.lower().endswith(".md")
    ]
    api = [
        path for path in paths
        if any(token in path.lower() for token in ("route", "controller", "handler", "endpoint", "api"))
        and not path.lower().endswith(".md")
    ]
    config = [
        path for path in paths
        if any(token in path.lower() for token in ("config", ".env", "settings"))
        and not path.lower().endswith(".md")
    ]
    if architecture and not any(path.startswith("docs/adr/") or "architecture" in path.lower() for path in docs):
        findings.append("Architecture-significant files changed without an architecture document or ADR update")
    if api and not any("api" in path.lower() or "endpoint" in path.lower() for path in docs):
        findings.append("API-related files changed without an API documentation update")
    if config and not any("config" in path.lower() or "setup" in path.lower() for path in docs):
        findings.append("Configuration-related files changed without a configuration/setup documentation update")
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Bounded documentation-gap heuristic")
    parser.add_argument("--base")
    parser.add_argument("--strict", action="store_true", help="exit non-zero on findings or unavailable evidence")
    args = parser.parse_args()
    paths, failure = changed_files(args.base)
    if failure:
        print(f"Docs check could not establish a reliable diff: {failure}")
        print("Perform a manual documentation review")
        return 2 if args.strict else 0
    if not paths:
        print("Docs check: diff is empty; perform a manual review if changes are uncommitted or outside Git")
        return 0
    findings = classify(paths)
    print("Documentation check")
    print(f"Changed files: {len(paths)}")
    if not findings:
        print("No heuristic documentation gaps detected")
        return 0
    for finding in findings:
        print(f"- WARNING: {finding}")
    print("This report is a heuristic, not proof of documentation completeness")
    return 1 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
