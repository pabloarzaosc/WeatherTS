#!/usr/bin/env bash
# Ship backend/ and palettes/ to the Oracle VM and (re)start the backend's
# container. Run from Git Bash on the PC:
#     deploy/oracle/deploy.sh <vm-ip>
# The disk caches live in a Docker volume, so a new build keeps them.
set -euo pipefail
HOST=${1:?usage: deploy/oracle/deploy.sh <vm-ip>}
KEY=~/.ssh/weatherts_oracle
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$HOST"
PKG=$(mktemp -u)-weatherts-backend.tgz

tar -C "$ROOT" \
  --exclude=backend/.venv --exclude=backend/build --exclude=backend/dist \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='backend/test_*' \
  -czf "$PKG" backend palettes deploy/oracle/Dockerfile
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$PKG" "ubuntu@$HOST:/tmp/weatherts-backend.tgz"
rm -f "$PKG"

$SSH 'set -e
  rm -rf ~/weatherts.new && mkdir -p ~/weatherts.new
  tar -xzf /tmp/weatherts-backend.tgz -C ~/weatherts.new
  rm -rf ~/weatherts && mv ~/weatherts.new ~/weatherts
  cd ~/weatherts
  sudo docker build -t weatherts-api -f deploy/oracle/Dockerfile .
  sudo docker rm -f weatherts-api >/dev/null 2>&1 || true
  sudo docker run -d --name weatherts-api --restart unless-stopped \
    -p 127.0.0.1:8787:8787 -v weatherts-cache:/tmp weatherts-api
  for i in $(seq 1 60); do curl -fs http://127.0.0.1:8787/health && echo && exit 0; sleep 2; done
  sudo docker logs --tail 50 weatherts-api; exit 1'
