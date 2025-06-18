FROM python:3.12-slim-bookworm

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update \
    # Runtime dependencies
  && apt-get install -y --no-install-recommends \
      ffmpeg \
      libsm6 \
      libxext6 \
  && rm -rf /var/lib/apt/lists/*

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

# Set PATH so .venv/bin is picked up
ENV PATH="/app/.venv/bin:$PATH"

# By default, show help
CMD ["echo", "Specify the correct command (see docker-compose.yml)"]
