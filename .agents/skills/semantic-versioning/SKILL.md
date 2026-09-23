---
name: semantic-versioning
description: Prepare a Semantic Versioning release by updating authoritative version sources and release documentation, validating the repository, creating a release commit, and adding an annotated Git tag.
---

# Semantic Versioning Release

Use this skill only when the user asks to bump a version, prepare a release, or create a release tag.

## Safety rules

- Read `docs/RELEASING.md` first when it exists; it overrides generic guidance here.
- Require a Git worktree with no unmerged paths or unrelated changes.
- Never rewrite, move, or delete an existing release tag.
- Never push commits, tags, or packages unless the user explicitly requests that separate action.
- Present the proposed version, changelog scope, commit, and tag, then obtain explicit human confirmation before creating the release commit or tag.

## Choose the version

Use `MAJOR.MINOR.PATCH` and a `vMAJOR.MINOR.PATCH` tag unless repository documentation specifies otherwise.

- `PATCH`: backward-compatible defect or documentation correction shipped to users.
- `MINOR`: backward-compatible capability. Before `1.0.0`, use this for intentional breaking changes while the public API is still unstable and call them out prominently.
- `MAJOR`: incompatible public behavior after `1.0.0`.
- Releasing `1.0.0` requires explicit confirmation that the public API is stable.

Do not infer a bump only from filenames. Review user-visible changes and commits since the latest release tag.

## Workflow

1. Read the release documentation and locate every authoritative version source.
2. Inspect `git status`, the latest `v*` tag, and commits since that tag.
3. Propose the bump and summarize why it has that SemVer level.
4. Update all authoritative version sources to the same value.
5. Update `CHANGELOG.md`: move completed work from `Unreleased` into a dated release section and preserve an empty `Unreleased` section.
6. Refresh derived examples, lockfiles, or generated files using repository-documented commands; do not hand-edit derived version strings.
7. Run the full documented test, validation, documentation, and package smoke checks.
8. Review the diff for unrelated changes, unresolved placeholders, stale versions, and accidental secrets.
9. Show the exact proposed release commit and annotated tag. Obtain explicit confirmation.
10. Recheck that the worktree and tag namespace have not changed, then create one release commit and one annotated tag.
11. Verify the tag points to the release commit and that the tagged CLI/package reports the same version.

Recommended Git shape:

```bash
git commit -m "chore(release): vX.Y.Z"
git tag -a "vX.Y.Z" -m "Release vX.Y.Z"
git show --no-patch "vX.Y.Z"
```

Report the new version, validation evidence, commit ID, tag, and whether anything remains unpushed or unpublished.
