FROM node:22-slim AS base
RUN apt-get update && apt-get install -y bash curl \
 && curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | bash \
 && apt-get update && apt-get install --no-install-recommends -y \
    infisical \
    dumb-init \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist

ENTRYPOINT [ "/usr/bin/dumb-init", "--" ]
CMD [ "infisical", "run", \
      "--projectId", "6fd5cbbf-ddf0-47b5-938b-ff752c3c6889", \
      "--env", "prod", \
      "--", "pnpm", "start" ]
