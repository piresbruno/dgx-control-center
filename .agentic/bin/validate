#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tomllib
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".agentic/manifest.json"
MANIFEST_SCHEMA = "agentic-bootstrap-manifest/v1"
VALID_STATUSES = {"Proposed", "Accepted", "Rejected", "Deprecated", "Superseded"}
TOKEN = re.compile(rb"\{\{[A-Z0-9_]+\}\}")
PORTABLE_FORBIDDEN = ("mcp__", "Task tool", ".claude/", ".codex/", ".opencode/", ".pi/")
ADR_FILENAME = re.compile(r"^(\d{4})-[a-z0-9][a-z0-9-]*\.md$")
ADR_REFERENCE = re.compile(r"ADR-(\d{4})")
REQUIRED_SECTIONS = (
    "## Context", "## Decision drivers", "## Considered options", "## Decision",
    "## Consequences", "## Implementation and validation", "## Revisit triggers", "## References",
)
ERRORS: list[str] = []


def error(message: str) -> None:
    ERRORS.append(message)


def safe_path(relative: str) -> Path | None:
    if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative:
        error(f"unsafe manifest path: {relative!r}")
        return None
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        error(f"unsafe manifest path: {relative!r}")
        return None
    path = ROOT.joinpath(*pure.parts)
    current = ROOT
    for part in pure.parts:
        current = current / part
        if current.is_symlink():
            error(f"manifest path contains symlink: {relative}")
            return None
    return path


def manifest_paths() -> list[Path]:
    if not MANIFEST.is_file() or MANIFEST.is_symlink():
        error("owned .agentic/manifest.json is required")
        return []
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error(f"invalid ownership manifest: {exc}")
        return []
    if data.get("schema") != MANIFEST_SCHEMA or not isinstance(data.get("files"), dict):
        error("invalid ownership manifest schema")
        return []
    paths = [MANIFEST]
    for relative, metadata in data["files"].items():
        path = safe_path(relative)
        if path is None:
            continue
        if (
            not isinstance(metadata, dict)
            or not isinstance(metadata.get("sha256"), str)
            or len(metadata.get("sha256", "")) != 64
            or not isinstance(metadata.get("executable"), bool)
            or not isinstance(metadata.get("mutable", False), bool)
        ):
            error(f"invalid manifest metadata: {relative}")
            continue
        if not path.is_file() or path.is_symlink():
            error(f"manifest-owned path is missing or not a file: {relative}")
            continue
        if not metadata.get("mutable", False):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != metadata["sha256"]:
                error(f"manifest-owned file content changed: {relative}")
            executable = bool(path.stat().st_mode & 0o100)
            if executable != metadata["executable"]:
                error(f"manifest-owned file mode changed: {relative}")
        paths.append(path)
    return paths


def validate_generated(paths: list[Path]) -> None:
    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        try:
            content = path.read_bytes()
        except OSError as exc:
            error(f"{relative}: cannot read: {exc}")
            continue
        if TOKEN.search(content):
            error(f"{relative}: unresolved template token")
        if relative == "AGENTS.md" or relative.startswith(".agents/skills/"):
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                error(f"{relative}: portable content must be UTF-8 text")
            else:
                for token in PORTABLE_FORBIDDEN:
                    if token in text:
                        error(f"{relative} contains platform-specific token: {token}")
                if relative.startswith(".agents/skills/") and relative.endswith("/SKILL.md"):
                    skill_name = relative.split("/")[-2]
                    if not text.startswith("---\n") or f"\nname: {skill_name}\n" not in text:
                        error(f"{relative}: skill front matter name must match its directory")
        if path.suffix == ".json":
            try:
                json.loads(content)
            except json.JSONDecodeError as exc:
                error(f"{relative}: invalid JSON: {exc}")
        elif path.suffix == ".toml":
            try:
                tomllib.loads(content.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                error(f"{relative}: invalid TOML: {exc}")
        expected_exec = relative.startswith(".agentic/bin/") or relative in {".githooks/pre-commit", "setup-hooks.sh"}
        if expected_exec and not os.access(path, os.X_OK):
            error(f"{relative}: expected executable mode")


def field(text: str, name: str) -> str | None:
    match = re.search(rf"^- \*\*{re.escape(name)}:\*\*\s*(.+?)\s*$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def references(value: str | None) -> set[str]:
    if value in {None, "None", "—", "-"}:
        return set()
    return set(ADR_REFERENCE.findall(value or ""))


def parse_index(text: str) -> dict[str, tuple[str, str | None]]:
    rows: dict[str, tuple[str, str | None]] = {}
    for line in text.splitlines():
        if not line.lstrip().startswith("|") or "ADR-" not in line:
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        match = ADR_REFERENCE.search(cells[0])
        if not match:
            continue
        adr_id = match.group(1)
        link_match = re.search(r"\(([^)]+\.md)\)", cells[0])
        if adr_id in rows:
            error(f"ADR index contains duplicate ADR-{adr_id}")
        rows[adr_id] = (cells[1], link_match.group(1) if link_match else None)
    return rows


def validate_adrs() -> None:
    adr_dir = ROOT / "docs/adr"
    index_path = adr_dir / "README.md"
    if not index_path.is_file():
        error("docs/adr/README.md is required")
        return
    index_rows = parse_index(index_path.read_text(encoding="utf-8"))
    records: dict[str, tuple[Path, str, set[str], set[str]]] = {}
    for path in sorted(adr_dir.glob("*.md")):
        if path.name in {"README.md", "template.md"}:
            continue
        match = ADR_FILENAME.match(path.name)
        if not match:
            error(f"{path.relative_to(ROOT)}: expected NNNN-short-title.md")
            continue
        adr_id = match.group(1)
        if adr_id in records:
            error(f"duplicate ADR id: {adr_id}")
            continue
        text = path.read_text(encoding="utf-8")
        status = field(text, "Status") or ""
        supersedes = references(field(text, "Supersedes"))
        superseded_by = references(field(text, "Superseded by"))
        records[adr_id] = (path, status, supersedes, superseded_by)
        if not text.startswith(f"# ADR-{adr_id}:"):
            error(f"{path.relative_to(ROOT)}: heading ID does not match filename")
        if status not in VALID_STATUSES:
            error(f"{path.relative_to(ROOT)}: invalid or missing Status")
        for section in REQUIRED_SECTIONS:
            if section not in text:
                error(f"{path.relative_to(ROOT)}: missing {section}")
    for adr_id, (path, status, supersedes, superseded_by) in records.items():
        row = index_rows.get(adr_id)
        if not row:
            error(f"{path.relative_to(ROOT)}: missing from ADR index")
        else:
            index_status, link = row
            if index_status != status:
                error(f"ADR-{adr_id}: index status does not match file status")
            if link and link != path.name:
                error(f"ADR-{adr_id}: index link does not match filename")
        for ref in supersedes | superseded_by:
            if ref not in records:
                error(f"ADR-{adr_id}: references missing ADR-{ref}")
        if status == "Superseded" and not superseded_by:
            error(f"{path.relative_to(ROOT)}: missing Superseded by link")
        if superseded_by and status != "Superseded":
            error(f"ADR-{adr_id}: Superseded by requires status Superseded")
        for replacement in superseded_by:
            if replacement in records:
                if records[replacement][1] != "Accepted":
                    error(f"ADR-{adr_id}: replacement ADR-{replacement} must be Accepted")
                if adr_id not in records[replacement][2]:
                    error(f"ADR-{adr_id}: replacement ADR-{replacement} does not reciprocally supersede it")
        if status == "Accepted":
            for previous in supersedes:
                if previous in records:
                    if records[previous][1] != "Superseded":
                        error(f"ADR-{adr_id}: superseded ADR-{previous} must have status Superseded")
                    if adr_id not in records[previous][3]:
                        error(f"ADR-{adr_id}: superseded ADR-{previous} does not link back")
    for adr_id, (_status, link) in index_rows.items():
        if adr_id not in records:
            error(f"ADR index references missing ADR-{adr_id}")
        elif link and not (adr_dir / link).is_file():
            error(f"ADR-{adr_id}: index link target does not exist")


agents = ROOT / "AGENTS.md"
if not agents.is_file() or agents.is_symlink():
    error("AGENTS.md must be a real file")
validate_generated(manifest_paths())
validate_adrs()

if ERRORS:
    print("Configuration validation failed:")
    for item in ERRORS:
        print(f"- {item}")
    sys.exit(1)
print("Configuration validation passed")
