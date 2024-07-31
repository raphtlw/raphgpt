#!/bin/bash

export $(cat .env | xargs) && telegram-bot-api --api-id=$TELEGRAM_API_ID --api-hash=$TELEGRAM_API_HASH --http-port=8081 --local &

export $(cat .env | xargs) && cd /prod/telegram-bot && pnpm start &

# Wait for any process to exit
wait -n

# Exit with status of process that exited first
exit $?
