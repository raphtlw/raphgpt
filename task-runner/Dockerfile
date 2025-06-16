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

# Copy files from app into container
COPY . /app

# Install dependencies
WORKDIR /app
RUN uv sync --frozen --no-cache

# Run application
CMD [ "/app/.venv/bin/fastapi", "run", "main.py", "--port", "80", "--host", "0.0.0.0" ]
