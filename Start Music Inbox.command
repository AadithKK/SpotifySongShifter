#!/bin/zsh
set -e
cd -- "$(dirname "$0")"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Install Node.js 20 or newer, then open this launcher again."
  read -k 1 "?Press any key to close."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

if curl -fsS http://127.0.0.1:4173/api/status >/dev/null 2>&1; then
  open http://127.0.0.1:4173
  exit 0
fi

node server.js &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

for attempt in {1..30}; do
  if curl -fsS http://127.0.0.1:4173/api/status >/dev/null 2>&1; then
    open http://127.0.0.1:4173
    wait "$server_pid"
    exit $?
  fi
  sleep .2
done

echo "Music Inbox did not start. Check the message above."
wait "$server_pid"
