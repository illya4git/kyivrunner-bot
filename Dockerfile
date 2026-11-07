# syntax=docker/dockerfile:1

# ---- deps + build -------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain only as a fallback: better-sqlite3 ships prebuilt binaries for linux x64/arm64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- mock Kyiv Digital API (development only; see compose.dev.yaml) -----------------
FROM build AS mock
COPY mock ./mock
ENV MOCK_HOST=0.0.0.0 MOCK_PORT=8787
EXPOSE 8787
CMD ["npx", "tsx", "mock/main.ts"]

# ---- production dependencies --------------------------------------------------------
FROM build AS prod-deps
RUN npm prune --omit=dev

# ---- runtime -------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/bot.sqlite \
    HEALTH_PORT=8080
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
