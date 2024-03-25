#!/bin/bash

OUTPUT_DIR="api/generated"

CONTAINER_ID="$(docker compose run --rm -d memgpt_server)"

sleep 10
docker cp "$CONTAINER_ID:/openapi_memgpt.json" .
docker cp "$CONTAINER_ID:/openapi_assistants.json" .

docker stop $CONTAINER_ID

mkdir -p "$OUTPUT_DIR"
pnpm openapi-zod-client ./openapi_memgpt.json -o "$OUTPUT_DIR/memgpt.ts"

rm openapi_*.json
