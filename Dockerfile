# syntax = docker/dockerfile:1

# Last Shelter: a Node + ws + better-sqlite3 server, run from source via tsx
# (no separate server build step). Serves HTTP on 0.0.0.0:$PORT (fly.toml
# sets PORT), upgrades /ws for the game's WebSocket protocol, and publishes
# README.md verbatim at /readme/ (spec/README.md says what's checked).
# Persisted state lives at /data/world.sqlite, on the one Fly volume.
# better-sqlite3's native build needs Python/make/g++, so the full Alpine
# build toolchain is installed before `pnpm install`.

FROM docker.io/library/node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json README.md ./
COPY public ./public
COPY src ./src
RUN pnpm build:client
ENV DB_PATH=/data/world.sqlite
CMD ["pnpm", "exec", "tsx", "src/server/index.ts"]
