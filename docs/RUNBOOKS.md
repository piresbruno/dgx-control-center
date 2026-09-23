# RUNBOOKS

Operational procedures. Each section names its milestone; unfilled sections are seeded stubs.

## 1. Node agent install (M1)

Goal: healthy agent on every DGX, `Restart=always`, watchdog enabled.

- Server issues the `install-agent` job over SSH (key auth preferred): upload bundled `agent/dist/main.js` → ensure Node ≥22 → write `~/.controlcenter/agent/config.json` (dashboard URL, token, sparkId) → systemd **system** unit → wait for first `hello`.
- Verify: node page shows transport `Agent vX` and state `consistent`; connectivity test passes.
- Repair: re-run install job (idempotent, `--force` redeploys the bundle). Diagnose via `journalctl -u controlcenter-agent`.

## 2. NAS / model store (M2)

- Register the store-owner host (LXC/VM mounting the share) as `kind: nas`; set `nasRoot` to the modelctl store root **as mounted on that node**.
- Validate `modelctl --version` there; modelctl operations run as single-flight jobs; NAS delete stays dry-run + armed apply.
- QNAP direct SSH is limited to read-only probes (declared `limited` node).

## 3. Cluster NCCL pins (M3)

- Multi-node recipes carry their own `.env` (NCCL_IB_HCA, SOCKET_IFNAME, GID policy). The dashboard never edits these; the recipe probe surfaces them read-only.
- On GID drift after reboot: recipe's own start script resolves per-node GID (`NCCL_IB_GID_AUTO=1`); investigate with `show_gids` on both ranks.

## 4. Gateway client onboarding (M4)

- Create a Client → issue API key (shown once) → client sets `base_url: http://<cc>:5555/v1`.
- Verify with a `/v1/models` GET using the key; first request appears in Analysis tagged with the client name.
- Payload capture per F4 defaults; redact-list applies to `api_key` fields.

## 5. Backup & restore (M7)

- Stop container (or use SQLite backup API), copy `config/` (single `.db` + JSON registries). Restore = stop, replace, start.
