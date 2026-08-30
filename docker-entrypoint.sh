#!/bin/sh
set -eu

source_config="${CONFIG_PATH:-/app/config.json}"
runtime_config="/tmp/chat-app-config.json"
if [ ! -r "$source_config" ]; then
  echo "Cannot read config file: $source_config" >&2
  exit 1
fi
cp "$source_config" "$runtime_config"
chown node:node "$runtime_config"
chmod 600 "$runtime_config"
export CONFIG_PATH="$runtime_config"

mkdir -p /app/chat
chown -R node:node /app/chat
exec gosu node "$@"
