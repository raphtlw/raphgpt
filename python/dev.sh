#!/usr/bin/env bash

source venv/bin/activate
set -a && source ../.env && set +a

fastapi dev main.py --port 53667
