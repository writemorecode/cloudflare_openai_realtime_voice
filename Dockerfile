# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update -qq \
  && apt-get install --no-install-recommends -y ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global pnpm@11.9.0

FROM base AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json agent/package.json
RUN pnpm install --frozen-lockfile --filter @ai-oral-exam/livekit-agent --ignore-scripts \
  && pnpm rebuild --filter @ai-oral-exam/livekit-agent
RUN pnpm --filter @ai-oral-exam/livekit-agent exec livekit-agents download-files
COPY agent/src agent/src
COPY agent/examiner_agent_system_prompt.md agent/examiner_agent_system_prompt.md
COPY agent/tsconfig.json agent/tsconfig.json
COPY agent/tsconfig.build.json agent/tsconfig.build.json
RUN pnpm --filter @ai-oral-exam/livekit-agent build \
  && PNPM_CONFIG_IGNORE_SCRIPTS=true pnpm --filter @ai-oral-exam/livekit-agent deploy --legacy --prod /agent-runtime

FROM base AS runtime

ARG UID=10001
RUN adduser \
  --disabled-password \
  --gecos "" \
  --home "/app" \
  --shell "/sbin/nologin" \
  --uid "${UID}" \
  appuser

WORKDIR /app
COPY --from=build --chown=appuser:appuser /agent-runtime /app

USER appuser
ENV NODE_ENV=production

CMD ["node", "dist/main.js", "start"]
