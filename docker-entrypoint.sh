#!/bin/bash

pnpm start &
fastapi run --port $PYTHON_PORT &

wait -n

exit $?
