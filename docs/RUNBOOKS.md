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

- Create a Client → issue API key (shown once) → client sets `base_url: http://<cc>:5566/v1`.
- Verify with a `/v1/models` GET using the key; first request appears in Analysis tagged with the client name.
- Payload capture per F4 defaults; redact-list applies to `api_key` fields.

## 5. Backup & restore (M7)

- Stop container (or use SQLite backup API), copy `config/` (single `.db` + JSON registries). Restore = stop, replace, start.

## 6. Power & clock control (M5)

- **One-time install** (per node, needs sudo): the `cc-clock` helper → `/usr/local/bin/cc-clock` (0755) and a sudoers drop-file scoped to exactly that binary:
  ```bash
  echo '<user> ALL=(root) NOPASSWD: /usr/local/bin/cc-clock' | sudo tee /etc/sudoers.d/cc-clock
  sudo chmod 0440 /etc/sudoers.d/cc-clock
  ```
  (The automated installer job does this when passwordless sudo exists; `visudo -cf` validates before install.)
- **Apply a profile**: Node page → Power & clocks → Full/Eco/Quiet. The desire persists in `config/clock-profiles.json`, writes through to desired-state, and the agent re-applies it on node boot.
- **Verify**: `sudo /usr/local/bin/cc-clock check`; GPU: `nvidia-smi -q -d CLOCK` (applications clocks); CPU: `cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_max_freq`.
- **Thermal guard**: auto-derates to Quiet at ≥80 °C GPU; reverts after <75 °C for 5 min. Events in `config/thermal-state.json`; state on `/api/power/thermal`. The guard never fights the operator — manual profiles resume after recovery.
- **Schedules**: per-node timezone windows (`PUT /api/power/schedules/:id`); the evaluator wins over the manual profile while a window is active.
- CPU caps write `scaling_max_freq` only — never `max_perf` (GB10 firmware re-derives the policy and reverts the cap).

## 7. Alerts (M6)

- Rules: seeded examples are read-only; user rules capped at 50. A breach must hold `forMs` before firing; clear ⇒ auto-resolve.
- Acknowledge stamps who/when; mute (24 h from the Alerts page) suppresses re-fire. Full trail in `alert_events` → Export history CSV.
- Delivery: WS toast to every open dashboard + optional webhooks (`config/alert-webhooks.json`, per-severity, generic JSON POST, no retries).
- Node-down fires after 2 min without an agent connection (the engine samples the node directory, so a pulled agent is always visible).

## 8. Gateway keys & upgrades (M7)

- Keys are hashed (SHA-256) — the full key shows exactly once at creation. Revoke blocks verification; deletion removes the record.
- **Upgrade an agent**: Serve/Node UI → `POST /api/nodes/:id/upgrade-agent` reinstalls the current bundle over SSH and restarts the agent. Version floor is enforced at hello (reject below `MIN_AGENT_VERSION`); a `capability-sweep` job reports node/tool versions as JSON.
- **Before upgrading the dashboard**: Settings → Create backup (checkpointed SQLite copy + config snapshot, `config/backups/<ts>/`). Restore = stop, restore files from the backup dir, start.

## 9. Fresh-machine recovery (M7)

1. Restore `config/` from a backup (it holds nodes, desired state, recipes, deployments, served models, clients, clock desires, schedules, alert rules, webhooks, and `controlcenter.db`).
2. `docker compose up -d --build`; verify `/api/health` + both agents `consistent` within 2 min.
3. Reinstall modelctl on nodes if missing: `GET /api/nodes/:id/modelctl-check`, then `POST /api/nodes/:id/provision-modelctl`.
4. M7 gate target: dashboard restart → healthy fleet → first gateway request in under 30 minutes.
