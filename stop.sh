#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export PUID="${PUID:-$(id -u)}" PGID="${PGID:-$(id -g)}"
docker compose down --remove-orphans
echo "clashadmin 已停止。数据保留在 ./data，下次 ./start.sh 会继续使用。"
