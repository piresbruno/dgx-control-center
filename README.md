# ControlCenter

Control plane for a home LocalAI infrastructure — 2× DGX Spark (GB10) + QNAP NAS model store: recipe-based serving of multiple models, an OpenAI-compatible gateway with per-client/per-request telemetry, full-fleet metrics, and DGX power/clock management.

- **Plan:** [PLAN.md](./PLAN.md) — vision, feature specs (F1–F8), ADR seeds, milestone roadmap (M0–M8)
- **Decisions:** [docs/adr/](./docs/adr/) — ADR-0001 … ADR-0008
- **Design:** [design/mockups/design-system.html](./design/mockups/design-system.html) — Pulse DS (approved: Slate Pro, light-first, mobile-first) + page mockups
- **Runbooks:** [docs/RUNBOOKS.md](./docs/RUNBOOKS.md)

## Layout

| Package | Purpose |
|---|---|
| `shared` | zod contracts: WS protocol, API types, domain enums (contract-first, ADR-0002/0007) |
| `server` | Fastify control plane: REST, WS hub, gateway, supervisor, metrics, stores |
| `agent` | Per-node daemon (outbound WS, sole runtime transport; SSH = bootstrap/repair) |
| `web` | React 19 + Vite SPA on the Pulse design system |

## Status

**91/92 roadmap tasks done — M0–M7 complete (gates passed on real hardware) + M8 Chat UI gate passed; only the v1.0.0 release tag remains.** See [docs/DEVELOPMENT_STATUS.md](./docs/DEVELOPMENT_STATUS.md) for the exact pick-up-elsewhere note, and [PLAN.md](./PLAN.md) for the full roadmap with recorded gate outcomes.

| Milestone | State |
|---|---|
| M0 Bootstrap | ✅ done |
| M1 Fleet Core (metrics, agents, rollups) | ✅ done — gate passed on real DGX1+DGX2 |
| M2 Model Plane (modelctl, remote jobs, Models UI) | ✅ done — gate passed (download→sync→visible on NAS+DGX) |
| M3 Serving (recipes, supervisor, Serve UI) | ✅ done — gate: GLM TP=2 via UI + concurrent models + orphan recovery |
| M4 Gateway & Analysis (router, keys, traces) | ✅ done — gate: live keyed routing + failover drill |
| M5 Power & Clocks | ✅ done — gate: reboot reconcile + thermal trigger + spark-only 409 |
| M6 Observability | ✅ done — gate: alert on pulled agent + kWh rollups populated |
| M7 Hardening & Release | ✅ 7/8 — gate passed (fresh clone → first gateway request **9 min 0 s**, budget 30 min); v1.0.0 tag deferred until M8 |
| M8 Chat UI | ✅ done — gate passed: live chat on `qwen3-0.6b`, folder context injected + persisted across restart, streaming markdown, image→vision routing |

CI-enforced gates: `tsc -b` + vitest (305 tests) + c8 lines ≥75% (actual ~84%) + Playwright e2e on the fake fleet.

## Install (fresh machine)

From clone to first gateway request:

```bash
git clone https://github.com/piresbruno/dgx-control-center.git controlcenter
cd controlcenter
mkdir -p config                                      # ADR-0003: bind-mounted state (SQLite + nodes.json)
cat > config/nodes.json <<'JSON'                     # seed at least one node (id = agent sparkId; createdAt required)
[{ "id": "dgx2", "name": "dgx2", "kind": "spark", "role": "worker",
   "lanIp": "100.122.3.115", "sshUser": "piresbruno", "llmPorts": [], "createdAt": 1790000000000 }]
JSON                                                 # (or add nodes later from the UI: Settings → Nodes)
docker compose up -d --build                         # dashboard on http://<host>:5566
curl -s localhost:5566/api/health                    # {"ok":true,...}
```

Then connect a node agent so the dashboard can drive it (systemd install via
`POST /api/nodes/:id/install-agent`, or manual: `node agent/dist/agent.mjs run <config.json>`
with `{"dashboardUrl":"http://<host>:5566","sparkId":"dgx2","token":"<CC_AGENT_TOKEN>"}` (metric cadences come from the dashboard welcome);
see [docs/RUNBOOKS.md](./docs/RUNBOOKS.md)).

First request end-to-end:

```bash
# 0. on the node: a recipe folder (start/stop/status verbs + .env the probe parses)
mkdir -p ~/recipes/qwen3-0.6b && cd ~/recipes/qwen3-0.6b
cat > .env <<'EOF'
PORT=8091
MODEL=Qwen/Qwen3-0.6B
SERVED_MODEL_NAME=qwen3-0.6b
EOF
cat > start.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"; source ./.env
MCTL="$(command -v modelctl || echo "$HOME/.local/bin/modelctl")"
docker rm -f cc-qwen >/dev/null 2>&1 || true
exec docker run -d --name cc-qwen --gpus all -p "$PORT:8000" \
  -v "$("$MCTL" path qwen3-0.6b)":/model:ro \
  -v cc-qwen-cache:/root/.cache/vllm \
  vllm/vllm-openai:qwen38-flash-next \
  --model /model --served-model-name "$SERVED_MODEL_NAME" --port 8000 \
  --max-model-len 8192 --enforce-eager
EOF
printf '#!/usr/bin/env bash\ndocker rm -f cc-qwen >/dev/null 2>&1 || true\n' > stop.sh
printf '#!/usr/bin/env bash\ncurl -sf -m 3 http://127.0.0.1:${PORT:-8091}/v1/models >/dev/null && echo running || echo stopped\n' > status.sh
chmod +x start.sh stop.sh status.sh
# the cache volume keeps vLLM's JIT/autotune warm: first boot ~4 min, later boots ~40 s

# 1. register the recipe folder (server-side; path is node-absolute)
curl -s localhost:5566/api/recipes -Hcontent-type:application/json \
  -d '{"nodeId":"dgx2","path":"/home/piresbruno/recipes/qwen3-0.6b"}'
# 2. probe it (detects PORT / SERVED_MODEL_NAME / verbs), 3. create + start the deployment
curl -s localhost:5566/api/serve/deployments -Hcontent-type:application/json -d '{"recipeId":"<recipeId>"}'
curl -s -X localhost:5566/api/serve/deployments/<id>/start
# 4. create a client key and expose the model on the gateway
curl -s localhost:5566/api/gateway/clients -Hcontent-type:application/json -d '{"name":"first"}'   # key shown once
curl -s localhost:5566/api/gateway/served-models -Hcontent-type:application/json \
  -d '{"alias":"qwen3-0.6b","targets":[{"nodeId":"dgx2","port":8091}]}'
# 5. OpenAI-compatible request through the gateway
curl -s localhost:5566/v1/chat/completions -Hauthorization:"Bearer <key>" -Hcontent-type:application/json \
  -d '{"model":"qwen3-0.6b","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

## Development

```bash
npm install
npm run dev:server   # Fastify on :5566
npm run dev:web      # Vite on :5173 (proxies /api)
npm test             # vitest (c8 gate ≥75% from M1)
npm run typecheck    # tsc -b + web noEmit
npm run lint         # eslint
```
