# syntax=docker/dockerfile:1

FROM python:3.11-bookworm
ENV PYTHONUNBUFFERED=1

RUN pip install -U pip setuptools wheel

ENV VENV=/opt/venv

RUN python3 -m venv ${VENV}
ENV PATH="${VENV}/bin:${PATH}"

RUN pip install -U pymemgpt[local]

RUN memgpt quickstart

WORKDIR /root/.memgpt

COPY init/config.ini config
COPY init/sqlite.db sqlite.db

COPY functions ./functions
COPY presets ./presets

RUN memgpt delete preset raphgpt_chat
RUN memgpt add preset -f presets/raphgpt_chat.yaml --name raphgpt_chat

# What the container should run when it is started.
ENTRYPOINT [ "memgpt" ]

# Run the memgpt server by default
CMD [ "server", "--host", "0.0.0.0" ]
