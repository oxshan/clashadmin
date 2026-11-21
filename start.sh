#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker 没有运行，请先启动 Docker。" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "已生成 .env，请先在其中填写 ADMIN_PASSWORD（至少 8 位）后重新运行。" >&2
  exit 1
fi

password=$(sed -n "s/^ADMIN_PASSWORD=//p" .env | tail -n 1 | sed -e "s/^['\"]//" -e "s/['\"]$//")
if [ "${#password}" -lt 8 ]; then
  echo ".env 中的 ADMIN_PASSWORD 未填写或不足 8 位。" >&2
  exit 1
fi

mkdir -p data
export PUID="${PUID:-$(id -u)}" PGID="${PGID:-$(id -g)}"

docker compose up -d --build --remove-orphans

port=$(sed -n "s/^PORT=//p" .env | tail -n 1)
port="${PORT:-${port:-8787}}"
echo "等待服务就绪…"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${port}/api/session"; then
    echo "clashadmin 已启动: http://127.0.0.1:${port}"
    echo "查看日志: docker compose logs -f    停止: ./stop.sh"
    exit 0
  fi
  sleep 1
done

echo "服务没有在 30 秒内就绪，最近的日志：" >&2
docker compose logs --tail 30 >&2
exit 1
