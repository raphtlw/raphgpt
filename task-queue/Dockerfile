FROM python:3.12-slim-bookworm

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Install node
COPY --from=node:latest /usr/local/bin/ /usr/local/bin/
COPY --from=node:latest /usr/local/lib/node_modules/ /usr/local/lib/node_modules/

# Install pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@latest-10

# Install dependencies
RUN apt-get update \
    # Runtime dependencies
  && apt-get install -y --no-install-recommends \
      ffmpeg \
      libsm6 \
      libxext6 \
  && rm -rf /var/lib/apt/lists/*

# Install codex
ADD https://github.com/raphtlw/codex/archive/refs/heads/raphtlw.tar.gz .
RUN tar -xvf raphtlw.tar.gz && \
    cd codex-raphtlw/codex-cli && \
    pnpm install && pnpm build && \
    pnpm link

# Copy dependency files only
COPY pyproject.toml /app/
# Optional: lock file if present
COPY uv.lock /app/

WORKDIR /app

# Install dependencies and set up venv
RUN uv venv && \
    uv pip install --upgrade pip && \
    uv sync --no-cache

# Add source code
COPY . .

# Set path python uses to resolve module imports
ENV PYTHONPATH=/app/app

# Set PATH so .venv/bin is picked up
ENV PATH="/app/.venv/bin:$PATH"

# By default, show help
CMD ["echo", "Specify the correct command (see docker-compose.yml)"]
