# ControlCenter server + web (single container, ADR-0003 file-backed DB in /app/config)
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 builds from source when no prebuild matches — needs the toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY agent/package.json agent/
COPY web/package.json web/
RUN npm ci
COPY tsconfig*.json ./
COPY shared shared
COPY server server
COPY agent agent
COPY web web
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Node inventories + provisioning shell out to ssh (ADR-0002 bootstrap).
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package*.json ./
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/server/package.json server/
COPY --from=build /app/agent/package.json agent/
COPY --from=build /app/web/package.json web/
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
ENV PORT=5566 BIND_HOST=0.0.0.0
EXPOSE 5566
VOLUME ["/app/config"]
CMD ["node", "server/dist/index.js"]
