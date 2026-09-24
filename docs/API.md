# ControlCenter API

> Generated from the live route table (`GET /api/openapi.json`). Auth: gateway `/v1/*` routes require a per-client bearer key; other routes are LAN-only by default.

## alerts

- `DELETE /api/alerts/rules/:id`
- `GET /api/alerts/events`
- `GET /api/alerts/history.csv`
- `GET /api/alerts/rules`
- `GET /api/alerts`
- `POST /api/alerts/:id/ack`
- `POST /api/alerts/:id/mute`
- `POST /api/alerts/:id/resolve`
- `POST /api/alerts/:id/unmute`
- `PUT /api/alerts/rules/:id`

## fleet

- `GET /api/jobs/:reqId`
- `GET /api/jobs`
- `GET /api/nodes/:id/modelctl-check`
- `GET /api/nodes/:id/models`
- `GET /api/nodes`
- `POST /api/jobs/:reqId/cancel`
- `POST /api/nodes/:id/jobs`
- `POST /api/nodes/:id/provision-modelctl`

## gateway

- `DELETE /v1/*`
- `GET /v1/*`
- `PATCH /v1/*`
- `POST /v1/*`
- `PUT /v1/*`
- `QUERY /v1/*`
- `TRACE /v1/*`

## llm

- `DELETE /llm/node/:id/:port/*`
- `GET /llm/node/:id/:port/*`
- `PATCH /llm/node/:id/:port/*`
- `POST /llm/node/:id/:port/*`
- `PUT /llm/node/:id/:port/*`
- `QUERY /llm/node/:id/:port/*`
- `TRACE /llm/node/:id/:port/*`

## models

- `DELETE /api/gateway/clients/:id`
- `DELETE /api/gateway/served-models/:id`
- `DELETE /api/recipes/:id`
- `DELETE /api/serve/deployments/:id`
- `GET /api/gateway/clients`
- `GET /api/gateway/served-models`
- `GET /api/models`
- `GET /api/recipes/:id`
- `GET /api/recipes`
- `GET /api/serve/deployments/:id`
- `GET /api/serve/deployments`
- `POST /api/gateway/clients/:id/revoke`
- `POST /api/gateway/clients`
- `POST /api/gateway/served-models`
- `POST /api/recipes/:id/probe`
- `POST /api/recipes`
- `POST /api/serve/deployments/:id/probe`
- `POST /api/serve/deployments/:id/restart`
- `POST /api/serve/deployments/:id/start`
- `POST /api/serve/deployments/:id/stop`
- `POST /api/serve/deployments`

## power

- `DELETE /api/power/schedules/:sparkId`
- `GET /api/power/clocks`
- `GET /api/power/energy`
- `GET /api/power/profiles`
- `GET /api/power/schedules`
- `GET /api/power/thermal`
- `PUT /api/power/clocks/:sparkId`
- `PUT /api/power/schedules/:sparkId`

## system

- `GET /agent-ws`
- `GET /api/analysis/export.csv`
- `GET /api/analysis/summary`
- `GET /api/analysis/traces`
- `GET /api/health`
- `GET /api/metrics/fleet`
- `GET /api/metrics/prometheus`
- `GET /api/openapi.json`
- `GET /api/system/backups`
- `GET /api/system/export`
- `GET /api/system/maintenance`
- `GET /api/system/settings`
- `GET /ws`
- `PATCH /api/system/settings`
- `POST /api/system/backup`
- `POST /api/system/import`
- `POST /api/system/maintenance`
