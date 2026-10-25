#!/usr/bin/env bash
# Сборка архива и выкладка MCP-сервера с машины разработчика (Git Bash / Linux / macOS).
#   deploy/release.sh              # тесты → архив → scp → deploy-mcp.sh на сервере
#   deploy/release.sh --pack-only  # только собрать архив (проверить состав)
#
# Нужно: ssh-доступ `ssh mison`, на сервере Node и /usr/local/bin/deploy-mcp.sh (deploy/README.md, шаги 1 и 3).
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${MISON_DEPLOY_HOST:-mison}"
version=$(node -p "require('./package.json').version")
archive="mison_mcp-${version}.tgz"
out="${TMPDIR:-/tmp}/${archive}"

echo "→ тесты"
npm test --silent

echo "→ архив ${archive}"
# Зависимости собираем здесь по lock-файлу и кладём в архив готовыми: на сервере не нужны ни npm, ни доступ к реестру,
# выкладка не зависит от того, что в интернете сегодня. Код — чистый JavaScript, сборки нет
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp package.json package-lock.json "$stage"/
cp -r src "$stage"/
(cd "$stage" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# Собрано на этой машине, запускается на Linux: нативный модуль в зависимостях здесь не заработает
if find "$stage/node_modules" -name '*.node' | grep -q .; then
	echo "ОШИБКА: в зависимостях появились нативные модули (*.node) — их нельзя собирать на этой машине." >&2
	echo "Соберите архив на Linux или верните на сервере 'npm ci' (удалите node_modules из архива)." >&2
	exit 1
fi

tar --force-local --exclude='node_modules/.bin' -czf "$out" -C "$stage" package.json package-lock.json src node_modules
echo "   $(tar -tzf "$out" | wc -l) файлов, $(du -h "$out" | cut -f1)"

if [ "${1:-}" = "--pack-only" ]; then
	echo "архив: $out"
	exit 0
fi

echo "→ загрузка на ${HOST}"
scp -q "$out" "${HOST}:/tmp/${archive}"

echo "→ выкладка"
ssh "$HOST" "sudo /usr/local/bin/deploy-mcp.sh /tmp/${archive} && rm -f /tmp/${archive}"

echo "готово: версия ${version}"
