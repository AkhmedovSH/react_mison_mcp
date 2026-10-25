#!/usr/bin/env bash
# Выкладка MCP-сервера на сервер (mcp.mison.uz). Запускается на сервере от root:
#   sudo /usr/local/bin/deploy-mcp.sh /tmp/mison_mcp-0.4.0.tgz
# Архив собирает deploy/release.sh на машине разработчика (вместе с готовыми node_modules) и кладёт в /tmp сам.
#
# Канон живёт в репозитории: deploy/deploy-mcp.sh. На сервере лежит КОПИЯ в /usr/local/bin/
# (не симлинк). Обновить копию: sudo install -m 755 deploy/deploy-mcp.sh /usr/local/bin/deploy-mcp.sh
#
# Схема: каждая версия — своя папка /var/www/mison_mcp/releases/<метка>, `current` — ссылка на активную.
# Сервис перезапускается, живость проверяется по /health; не поднялся — ссылка возвращается на прежний релиз.
set -euo pipefail

ARCHIVE="${1:?укажите архив: deploy-mcp.sh /tmp/mison_mcp-<версия>.tgz}"
ROOT=/var/www/mison_mcp
SERVICE=mison-mcp
HEALTH=http://127.0.0.1:3300/health
KEEP=5
NOTIFY=/usr/local/bin/deploy-notify.sh

[ -f "$ARCHIVE" ] || { echo "нет файла $ARCHIVE" >&2; exit 1; }
command -v node >/dev/null || { echo "на сервере нет node: установите Node 24 (deploy/README.md, шаг 1)" >&2; exit 1; }

mkdir -p "$ROOT/releases"
stamp=$(date +%Y%m%d-%H%M%S)
release="$ROOT/releases/$stamp"
previous=$(readlink -f "$ROOT/current" 2>/dev/null || true)
step="распаковка"

notify() {
	[ -x "$NOTIFY" ] || return 0
	{
		echo "project=mcp.mison.uz"
		echo "status=$1"
		echo "line=$2"
	} | "$NOTIFY" || true
}

fail() {
	echo "ОШИБКА на шаге «$step»" >&2
	if [ -n "$previous" ] && [ -d "$previous" ]; then
		ln -sfn "$previous" "$ROOT/current"
		systemctl restart "$SERVICE" || true
		echo "возврат на прежний релиз: $previous" >&2
	fi
	rm -rf "$release"
	notify failure "упало на шаге: $step"
	exit 1
}
trap fail ERR

mkdir -p "$release"
tar -xzf "$ARCHIVE" -C "$release"

step="зависимости"
if [ -d "$release/node_modules" ]; then
	# Обычный путь: release.sh собрал зависимости заранее, на сервере ничего не скачивается
	echo "зависимости пришли в архиве"
else
	command -v npm >/dev/null || { echo "в архиве нет node_modules, а на сервере нет npm" >&2; false; }
	# Запасной путь: только боевые зависимости, строго по lock-файлу
	(cd "$release" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi

step="проверка загрузки"
(cd "$release" && node --check src/http.js && node -e "import('./src/http.js').then(() => process.exit(0))")

step="переключение релиза"
ln -sfn "$release" "$ROOT/current"
systemctl restart "$SERVICE"

step="проверка /health"
ok=0
for _ in $(seq 1 15); do
	if curl -fsS --max-time 3 "$HEALTH" >/dev/null 2>&1; then ok=1; break; fi
	sleep 1
done
[ "$ok" = 1 ] || false

version=$(node -p "require('$release/package.json').version")
echo "выложено: версия $version, релиз $stamp"

# Старые релизы убираем, оставляя KEEP последних
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -rf
trap - ERR
notify success "версия $version, релиз $stamp"
