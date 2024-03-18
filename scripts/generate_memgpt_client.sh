#!/bin/bash

CONTAINER_TAG="memgpt_client_generation"
OUTPUT_DIR="api/generated"

docker build -t "$CONTAINER_TAG" ./memgpt

CONTAINER_ID="$(docker run --rm -d "$CONTAINER_TAG")"

sleep 10
docker cp "$CONTAINER_ID:/root/.memgpt/openapi_memgpt.json" .
docker cp "$CONTAINER_ID:/root/.memgpt/openapi_assistants.json" .

docker stop $CONTAINER_ID
docker rmi $CONTAINER_TAG

mkdir -p "$OUTPUT_DIR"
pnpm openapi-zod-client ./openapi_memgpt.json -o "$OUTPUT_DIR/memgpt.ts"

rm openapi_*.json
