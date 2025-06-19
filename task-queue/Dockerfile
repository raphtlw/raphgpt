FROM rust:latest AS base
RUN cargo install sccache
RUN cargo install cargo-chef
ENV RUSTC_WRAPPER=sccache SCCACHE_DIR=/sccache

# BEGIN INSTALL_CODEX

# Install node
COPY --from=node:latest /usr/local/bin/ /usr/local/bin/
COPY --from=node:latest /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@latest-10

# Install codex
ADD https://github.com/raphtlw/codex/archive/refs/heads/raphtlw.tar.gz .
RUN tar -xvf raphtlw.tar.gz && \
    cd codex-raphtlw/codex-cli && \
    pnpm install && pnpm build && \
    pnpm link

# END INSTALL_CODEX

FROM base AS planner
WORKDIR /task-queue
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    cargo chef prepare --recipe-path recipe.json

FROM base AS builder
WORKDIR /task-queue
COPY --from=planner /task-queue/recipe.json recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=$SCCACHE_DIR,sharing=locked \
    cargo build --release

FROM base AS runner
WORKDIR /task-queue
COPY --from=builder /task-queue/target/release/task-queue /bin/task-queue
CMD [ "task-queue" ]
