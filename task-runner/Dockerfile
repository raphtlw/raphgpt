FROM python:3.12-slim-bookworm

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN apt-get update \
    # Runtime dependencies
  && apt-get install -y --no-install-recommends \
      ffmpeg \
      libsm6 \
      libxext6 \
      git \
  && rm -rf /var/lib/apt/lists/*

# Copy dependencies only
COPY pyproject.toml uv.lock /app/

# Install dependencies
WORKDIR /app
RUN uv sync --frozen --no-cache

# Add source code
COPY . .

# Run application and Celery worker
CMD ["sh", "-c", "/app/.venv/bin/celery -A app.app worker --loglevel=info --logfile=- & exec /app/.venv/bin/fastapi run app/main.py --port 80 --host 0.0.0.0"]
