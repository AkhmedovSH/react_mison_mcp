# Развёртывание удалённого MCP-сервера (mcp.mison.uz)

Удалённый вариант принимает запросы по HTTPS: `POST https://mcp.mison.uz/mcp` с заголовком
`Authorization: Bearer <API-ключ Mison>`. Ключ клиента нигде не хранится: на каждый запрос сервер собирает
инструменты под этот ключ и ходит в партнёрское API от его имени. Токены Mison кэшируются в памяти по sha256-отпечатку
ключа, в журнале видны только первые 8 знаков отпечатка.

```
клиент (Claude Code, бот…) ──HTTPS──► nginx :443 ──► node src/http.js 127.0.0.1:3300 ──► backend.mison.uz
```

Сервер Mison: Ubuntu 22.04, nginx и certbot уже стоят (`/var/www/letsencrypt` — webroot для сертификатов).
**Node на сервере нужно поставить** — это первый шаг.

Все команды ниже выполняются на сервере (`ssh mison`), если не сказано иное. Шаги 1–4 — один раз.

## 1. Node 24 LTS

Node 20 снят с поддержки (апрель 2026), ставим 24-ю ветку — на ней же прогоняются тесты. Официальный архив с проверкой
контрольной суммы, в `/opt`, без подключения репозиториев apt и без `curl | bash`:

```bash
cd /tmp
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
FILE=$(grep 'linux-x64.tar.xz' SHASUMS256.txt | awk '{print $2}')
curl -fsSLO https://nodejs.org/dist/latest-v24.x/$FILE
grep " $FILE$" SHASUMS256.txt | sha256sum -c -          # должно быть: ...: OK
sudo tar -xJf $FILE -C /opt
sudo ln -sfn /opt/${FILE%.tar.xz} /opt/node
sudo ln -sf /opt/node/bin/node /usr/local/bin/node
sudo ln -sf /opt/node/bin/npm /usr/local/bin/npm
sudo ln -sf /opt/node/bin/npx /usr/local/bin/npx
node -v   # v24.x
```

Обновление Node — та же последовательность с новым архивом (ссылка `/opt/node` переключается на новую папку).

## 2. DNS

Запись `A`: `mcp.mison.uz` → `82.148.2.156`. Проверка: `dig +short mcp.mison.uz`.

## 3. Файлы на сервере

С машины разработчика, из корня `mison_mcp`:

```bash
scp deploy/deploy-mcp.sh deploy/mison-mcp.service deploy/mison-mcp.env.example \
    deploy/nginx-mcp.mison.uz.http.conf deploy/nginx-mcp.mison.uz.conf mison:/tmp/
```

На сервере:

```bash
sudo install -m 755 /tmp/deploy-mcp.sh /usr/local/bin/deploy-mcp.sh
sudo install -m 644 /tmp/mison-mcp.service /etc/systemd/system/mison-mcp.service
sudo install -m 640 /tmp/mison-mcp.env.example /etc/mison-mcp.env     # все строки закомментированы
sudo mkdir -p /var/www/mison_mcp/releases
sudo systemctl daemon-reload
```

Для первого запуска разумно включить в `/etc/mison-mcp.env` строку `MISON_MCP_READONLY=true` — без инструментов записи.
Позже её убирают (или оставляют, если ассистентам запись не нужна).

## 4. Первая выкладка

С машины разработчика:

```bash
deploy/release.sh
```

Скрипт прогоняет тесты, собирает архив (`package.json`, `package-lock.json`, `src/` и готовые `node_modules` — зависимости ставятся здесь,
на сервере npm не нужен), копирует на сервер и запускает
`deploy-mcp.sh`: распаковка в `/var/www/mison_mcp/releases/<метка>`, проверка загрузки, переключение ссылки `current`,
перезапуск сервиса и проверка `/health`. Не поднялся — ссылка возвращается на прежний релиз.

Первый раз сервис ещё не включён:

```bash
sudo systemctl enable --now mison-mcp
curl -s http://127.0.0.1:3300/health      # {"ok":true,"version":"0.4.0",…}
journalctl -u mison-mcp -n 20 --no-pager
```

## 5. nginx и сертификат

Сначала только порт 80, чтобы выпустить сертификат:

```bash
sudo install -m 644 /tmp/nginx-mcp.mison.uz.http.conf /etc/nginx/sites-available/mison_mcp
sudo ln -sf /etc/nginx/sites-available/mison_mcp /etc/nginx/sites-enabled/mison_mcp
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d mcp.mison.uz
```

Затем боевой конфиг с TLS:

```bash
sudo install -m 644 /tmp/nginx-mcp.mison.uz.conf /etc/nginx/sites-available/mison_mcp
sudo nginx -t && sudo systemctl reload nginx
```

Если `nginx -t` ругается на `limit_req_zone … already exists`, в nginx уже есть зона с таким именем — переименуйте
`mison_mcp` в обоих местах конфига.

## 6. Проверка снаружи

С машины разработчика:

```bash
deploy/smoke.sh                              # живость, отказ без ключа
MISON_API_KEY=<ключ> deploy/smoke.sh         # + подключение и список инструментов
```

Ключ для проверки — отдельный, с правом только на отчёты (кабинет → Интеграции → API-ключи).

## 7. Подключение клиентов

Ключ клиент передаёт заголовком `Authorization: Bearer <ключ>`:

```bash
# Claude Code
claude mcp add --transport http mison https://mcp.mison.uz/mcp --header "Authorization: Bearer ВАШ_КЛЮЧ"
```

```json
// Cursor, ~/.cursor/mcp.json
{ "mcpServers": { "mison": { "url": "https://mcp.mison.uz/mcp", "headers": { "Authorization": "Bearer ВАШ_КЛЮЧ" } } } }
```

Для бота на своём сервере — любой MCP-клиент с заголовками (Agent SDK, Messages API с MCP-коннектором и токеном
авторизации). Сузить набор инструментов можно заголовками запроса: `X-Mison-Readonly: true`,
`X-Mison-Groups: reports,receipts`. Расширить сверх настроек сервера нельзя.

**Ограничение:** веб-интерфейсы claude.ai и ChatGPT подключают коннекторы через OAuth, статический ключ в заголовке
там задать нельзя. Для них нужен слой OAuth — он не сделан.

## 8. Обновление, откат, логи

```bash
deploy/release.sh                                   # новая версия (с машины разработчика)
ls -1dt /var/www/mison_mcp/releases/*/              # доступные релизы (хранится 5 последних)
sudo ln -sfn /var/www/mison_mcp/releases/<метка> /var/www/mison_mcp/current && sudo systemctl restart mison-mcp   # откат
journalctl -u mison-mcp -f                          # журнал запросов (JSON, без ключей)
sudo systemctl status mison-mcp
```

Изменение настроек: правка `/etc/mison-mcp.env` и `sudo systemctl restart mison-mcp`.
Новую копию `deploy-mcp.sh` на сервере обновляйте так же, как в шаге 3: `sudo install -m 755 …`.

## 9. Безопасность и лимиты

- Ключ клиента — только в заголовке; в журнал nginx он не попадает (формат `combined` заголовок не пишет), в журнал
  сервиса — тоже (только отпечаток).
- На ключ — 300 запросов в минуту (`MISON_MCP_HTTP_RATE_LIMIT`), с одного адреса — 30 неудачных входов в минуту
  (`MISON_MCP_HTTP_AUTH_FAIL_LIMIT`), поверх этого nginx ограничивает адрес 30 запросами в секунду.
- Сервис работает под временным пользователем systemd без прав записи и без домашней папки, слушает только
  `127.0.0.1`, память ограничена 512 МБ.
- Отозвать доступ клиента — удалить или перевыпустить ключ в кабинете: новые запросы получат 401.
- Права инструментов определяет ключ клиента (галочки «Доступ к отчётам», «Приход товара» и так далее), поэтому
  ассистенту стоит заводить отдельный ключ с минимумом прав.
