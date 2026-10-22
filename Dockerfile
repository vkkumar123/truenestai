# syntax=docker/dockerfile:1.7
# Production image for Cloud Run. Multi-stage: install, build (Next standalone output), run.
# Build: docker build --secret id=next_actions_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
#          --build-arg DEPLOYMENT_VERSION=$(git rev-parse HEAD) -t truenest .
# No runtime secrets are baked in: Cloud Run injects them from Secret Manager at start-up.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG DEPLOYMENT_VERSION=""
ENV DEPLOYMENT_VERSION=${DEPLOYMENT_VERSION}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Server Functions encryption key: must be identical for every instance of a build, and Next
# embeds it in the server output, so it is passed as a BuildKit secret (never a layer or arg).
# Optional so local builds work; the deploy workflow always provides it.
RUN --mount=type=secret,id=next_actions_key \
    if [ -s /run/secrets/next_actions_key ]; then \
      export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_actions_key)"; \
    fi; \
    npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
