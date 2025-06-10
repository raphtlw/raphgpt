FROM oven/bun AS base

COPY --from=node:latest /usr/local/bin/ /usr/local/bin/
COPY --from=node:latest /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

RUN --mount=target=/var/lib/apt/lists,type=cache,sharing=locked \
    --mount=target=/var/cache/apt,type=cache,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
    # System utilities
  && apt-get install -y --no-install-recommends \
      locales \
      gnupg \
      wget \
      curl \
      ca-certificates \
    # Build dependencies
  && apt-get install -y --no-install-recommends \
      make \
      git \
      zlib1g-dev \
      libssl-dev \
      gperf \
      cmake \
      clang \
      libc++-dev \
      libc++abi-dev \
      build-essential \
      libbz2-dev \
      libreadline-dev \
      libsqlite3-dev \
      libncursesw5-dev \
      xz-utils \
      tk-dev \
      libxml2-dev \
      libxmlsec1-dev \
      libffi-dev \
      liblzma-dev \
      python3 \
    # Runtime dependencies
  && apt-get install -y --no-install-recommends \
      zip \
      unzip \
      ghostscript \
      graphicsmagick \
      ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Generate locale
RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG=en_US.UTF-8

# App directory
WORKDIR /app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
COPY patches /temp/dev/patches
RUN cd /temp/dev && ls -la && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
COPY patches /temp/prod/patches
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /app .

# run the app
CMD [ "bun", "run", "main.ts" ]
