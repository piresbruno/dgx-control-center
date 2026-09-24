# Releasing

Use the `semantic-versioning` skill for version bumps, releases, and Git tags.

## Release contract

- Versions follow Semantic Versioning: `MAJOR.MINOR.PATCH`.
- Release tags are annotated and use `vMAJOR.MINOR.PATCH`.
- The changelog records user-visible changes.
- Tests and configured validators must pass before tagging.
- Publishing commits, tags, or packages requires separate explicit approval.

## Repository configuration

1. **Authoritative version files** — all five workspace manifests (`package.json`, `shared/`, `server/`, `agent/`, `web/`) plus `shared/src/version.ts` (the runtime `VERSION` reported by `/api/health` and the handshake). All six must carry the same value.
2. **Derived references** — `MIN_AGENT_VERSION` in `shared/src/version.ts` moves independently (agent protocol floor, not the dashboard version); do not bump it with the release.
3. **Required checks** — `npm run build` (tsc), `npm run test:coverage` (vitest + c8 lines ≥75%), `npx playwright test` (fake-fleet e2e), `.agentic/bin/validate`.
4. **Release branch** — `main`; commits land via `git -c core.hooksPath=.githooks commit`.
5. **Registry/deployment** — none: deployment is `docker compose up -d --build` from a release checkout (see docs/DEVELOPMENT_STATUS.md). Nothing is published to a package registry.

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
