# syntax = docker/dockerfile:1

# The Wall: a plain Node server (node:http + the built-in node:sqlite), no
# runtime npm dependencies, no build step — Node 24 runs server.ts directly.
# Serves HTTP on 0.0.0.0:$PORT (fly.toml sets PORT) and README.md verbatim at
# /readme/ (spec/README.md says what's checked). Persisted state lives at
# /data/app.db, on the one Fly volume.

FROM docker.io/library/node:24-alpine
WORKDIR /app
COPY server.ts README.md ./
ENV DB_PATH=/data/app.db
CMD ["node", "server.ts"]
