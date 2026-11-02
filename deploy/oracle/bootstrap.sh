#!/usr/bin/env bash
# One-time setup of the Oracle VM (Ubuntu 24.04, arm64), run on the VM:
# Docker for the backend's container, cloudflared for the tunnel that gives it
# an https name with no port open to the internet, and swap as a cushion.
set -euo pipefail

sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io curl
sudo systemctl enable --now docker

if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  sudo dpkg -i /tmp/cloudflared.deb
fi

# 4 GB of swap: a burst of satellite and model work never takes the box down.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

docker --version
cloudflared --version
free -h
