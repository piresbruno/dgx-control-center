# ADR-0009: Store operations execute on nodes; dashboard is filesystem-independent

- **Status:** Accepted
- **Date:** 2026-09-25
- **Decision owners:** piresbruno
- **Scope:** server, deploy, docs
- **Tags:** model-plane, transport, deployment
- **Supersedes:** None
- **Superseded by:** None

## Context

The dashboard container (control plane) currently requires host filesystem coupling: it bind-mounts the NAS model store (`/mnt/nas:ro`), the modelctl/uv tool trees, and `~/.config/modelctl` so that `GET /api/models` can run `modelctl list --json` locally (`server/src/modelctl/service.ts` local `execFile` runner). This welds the control plane to one specific Linux host layout:

- The compose file fails on any host without that exact layout (observed: Docker Desktop on macOS rejects `/mnt/nas` at container create).
- A plain Linux host without the mounts starts silently with an empty catalog (Docker auto-creates an empty bind source).
- The owner requirement: the dashboard must be completely separated from the nodes — the nodes are the ones that connect between themselves. The store mount is a node concern: DGX/gpu-host nodes mount the NAS share directly (both DGXs already mount `//nas.as267.com/llms` at `/mnt/nas` via fstab automount) and engines read weights from it.

## Decision drivers

- Control-plane portability: the dashboard must run from `./config` + an SSH identity alone (ADR-0002 already restricts SSH to bootstrap/repair).
- Single writer per data path: runtime operations ride the agent job channel (`job-run/out/exit`), not host-local shortcuts.
- Honest degradation: an unreachable store must surface as an explicit error snapshot, never a silent empty catalog.
- Node-to-node data flow: downloads/pushes already run node→store and node→node (`modelctl-download`, `modelctl-sync-local`, `modelctl-push` job kinds); the catalog is the only dashboard-local store operation left.

## Considered options

### Option 1 — Keep dashboard-local modelctl with optional remote dispatch

Lowest effort, but keeps the dual execution paths ADR-0002 eliminated for transport: two code paths for one operation, the host-mount requirement stays, and the Mac/LXC portability problem remains.

### Option 2 — Execute the store catalog on a node via the agent job channel (selected)

The catalog dispatches as a job to a registered node that mounts the store and has modelctl provisioned. The dashboard keeps only the TTL/stale caching layer. Compose drops every store/tool mount. Failure to reach a capable node produces an error snapshot (visible in the Models page), not an empty catalog.

### Option 3 — Read the store over SMB/NFS from inside the dashboard container

Moves the mount problem instead of removing it (container still needs kernel filesystem access or a host mount), adds credentials to the container, and violates "nodes connect between themselves".

## Decision

Option 2. Specifically:

1. New job kind `modelctl-list-store` (argv `modelctl list --json`) executes on a node selected at request time: a registered `kind: "nas"` store-owner node first, else connected `spark`/`gpu-host` nodes in directory order. The runner awaits job termination via `JobsManager.onFinished` and rejects on non-zero exit.
2. `ModelctlService` keeps TTL caching, stale-within-5×-TTL serving, and single-flight dedup; its runner becomes mandatory and node-dispatching. The local `execFile` default runner, `modelctlPath`, `resolveModelctlPath`, `CC_MODELCTL_PATH`, and the unused `version()` probe are removed (clean cutover).
3. `docker-compose.yml` keeps only `./config` (ADR-0003 durable state) and the read-only `~/.ssh` mount + `CC_SSH_IDENTITY` (bootstrap/repair identity, ADR-0002). `/mnt/nas`, uv, modelctl, and `.config/modelctl` mounts are removed.
4. The API contract (`GET /api/models` returning `InventorySnapshot`) is unchanged; the web Models page needs no changes.
5. Deployment prerequisite moves to the node: the store node needs modelctl provisioned (`POST /api/nodes/:id/provision-modelctl`) and its `~/.config/modelctl` pointed at the mounted store. Without a capable connected node, `/api/models` returns an explicit error snapshot instructing registration/provisioning.

## Consequences

### Positive

- The dashboard container runs on any host (dgx-1, LXC, Docker Desktop on macOS) with no node-layout knowledge.
- One execution path per operation, consistent with ADR-0002's transport rule.
- Store visibility failures are explicit and actionable (error snapshot), never silently empty.

### Negative

- The catalog depends on agent connectivity to a store-capable node (same dependency class as every other runtime feature per ADR-0002).
- Node-local inventory (`GET /api/nodes/:id/models`) still uses runtime SSH — pre-existing, unchanged here; flagged under revisit triggers.

### Risks and mitigations

- No node has modelctl configured for the store → error snapshot names the remedy (register `kind: nas` store owner or provision modelctl on a node).
- Flappy catalog when the selected node's agent reconnects mid-TTL → existing TTL/stale cache serves the last good snapshot for 5× TTL.

## Implementation and validation

- `modelctl-list-store` job kind; `server/src/modelctl/storeInventory.ts` runner (selection + dispatch + await); `ModelctlService` runner made mandatory; compose slimmed; `CC_MODELCTL_PATH` removed from config.
- Validation: unit tests for node selection (nas-kind preference, directory-order fallback, not-connected error, non-zero exit error), `commands.test.ts` argv mapping, existing `/api/models` route tests against the injected runner, full vitest suite, Playwright e2e on the fake fleet.

## Revisit triggers

- A second store consumer appears that needs catalog pinning per workload → promote node selection to an explicit setting (`storeNodeId`).
- Runtime SSH for node-local inventories becomes a reliability problem → move `GET /api/nodes/:id/models` onto the job channel as well.
- The QNAP gains the ability to run agents/modelctl → register it directly as the store owner.

## References

- Owner directive (session, 2026-09-25): dashboard fully separated from nodes; nodes connect between themselves; `/mnt/nas` belongs on the DGX nodes, not the dashboard container.
- ADR-0002 (agent-only runtime transport; SSH = bootstrap/repair), ADR-0003 (config volume).
- RUNBOOKS §9 (NAS store owner registration), §10 (LXC dashboard host, step 2 becomes unnecessary).
- Observed incident: Docker Desktop mounts-denied on `/mnt/nas` (2026-09-25).
