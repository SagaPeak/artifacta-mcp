# Hosted Artifacta MCP server (AG-04) — Streamable HTTP for Railway.
# Multi-stage: the build toolchain and source never reach the final image, and
# the container runs as a non-root user with no secrets baked in.
# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript -> dist/ ----
FROM node:20-slim AS build
WORKDIR /app
# Reproducible install against the lockfile (dev deps included for tsc).
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps + dist only ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Production dependencies only — no dev toolchain, no TypeScript sources.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Drop privileges: the base image ships an unprivileged `node` user.
USER node

# Railway injects PORT at runtime; the CLI also falls back to $PORT when --port
# is absent. `exec` makes node PID 1 so SIGTERM reaches it for graceful shutdown.
EXPOSE 8080
CMD ["sh", "-c", "exec node dist/cli.js --transport=http --port=${PORT:-8080}"]
