#!/usr/bin/env bash
# Проверка выложенного MCP-сервера снаружи.
#   deploy/smoke.sh                                  # без ключа: живость и отказ без авторизации
#   MISON_API_KEY=<ключ> deploy/smoke.sh             # с ключом: подключение и список инструментов
#   MCP_URL=https://mcp.mison.uz deploy/smoke.sh     # другой адрес
set -uo pipefail

BASE="${MCP_URL:-https://mcp.mison.uz}"
fail=0
check() { # описание, ожидаемый код, фактический код
	if [ "$2" = "$3" ]; then echo "  ок   $1 ($3)"; else echo "  FAIL $1: ждали $2, получили $3"; fail=1; fi
}

echo "→ $BASE"
check "GET /health" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/health")"
check "POST /mcp без ключа" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}')"
check "GET /mcp (сессий нет)" 405 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/mcp")"

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
if [ -n "${MISON_API_KEY:-}" ]; then
	check "initialize с неверным ключом" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer 00000000-0000-0000-0000-000000000000' -d "$INIT")"
	check "initialize с вашим ключом" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $MISON_API_KEY" -d "$INIT")"

	tools=$(curl -s --max-time 30 -X POST "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $MISON_API_KEY" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -o '"name":"mison_' | wc -l)
	if [ "$tools" -ge 40 ]; then echo "  ок   tools/list: $tools инструментов"; else echo "  FAIL tools/list: $tools инструментов"; fail=1; fi
else
	echo "  (без MISON_API_KEY проверка ключа пропущена)"
fi

[ "$fail" = 0 ] && echo "всё в порядке" || { echo "есть ошибки"; exit 1; }
