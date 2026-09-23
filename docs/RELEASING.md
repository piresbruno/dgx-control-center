# Releasing

Use the `semantic-versioning` skill for version bumps, releases, and Git tags.

## Release contract

- Versions follow Semantic Versioning: `MAJOR.MINOR.PATCH`.
- Release tags are annotated and use `vMAJOR.MINOR.PATCH`.
- The changelog records user-visible changes.
- Tests and configured validators must pass before tagging.
- Publishing commits, tags, or packages requires separate explicit approval.

## Repository configuration

Before the first release, document:

1. The authoritative version file or files.
2. Commands that refresh derived version references and examples.
3. Required test, validation, build, and package-smoke commands.
4. The release branch and any protected-branch requirements.
5. Whether a package registry or deployment is part of a release.

Do not create a tag until these facts are known. Keep this file focused and link to detailed deployment documentation rather than duplicating it.

## Release checklist

1. Start from a clean Git worktree.
2. Review changes since the latest `v*` tag.
3. Propose and confirm the SemVer bump.
4. Update authoritative version sources and `CHANGELOG.md`.
5. Refresh generated artifacts.
6. Run all documented validation.
7. Review and confirm the release diff.
8. Create `chore(release): vX.Y.Z`.
9. Create annotated tag `vX.Y.Z`.
10. Verify the tagged version; push or publish only when explicitly requested.
