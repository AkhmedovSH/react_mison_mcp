import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startMockApi } from './mock-api.js'
import { ok } from '../src/result.js'

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url))
let mock

before(async () => {
	mock = await startMockApi()
})
after(async () => {
	await mock.close()
})

async function connect(env = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [ENTRY],
		env: { ...process.env, MISON_API_KEY: 'good-key', MISON_API_URL: mock.url, ...env },
		stderr: 'pipe',
	})
	const client = new Client({ name: 'test', version: '0' })
	await client.connect(transport)
	return client
}

const textOf = (result) => result.content.map((part) => part.text).join('\n')

test('список инструментов: чтение и запись, у записи есть confirmed', async () => {
	const client = await connect()
	const { tools } = await client.listTools()
	const names = tools.map((tool) => tool.name)

	assert.ok(tools.length >= 40, `инструментов ${tools.length}`)
	assert.equal(new Set(names).size, names.length, 'имена уникальны')
	for (const required of ['mison_points', 'mison_olap_report', 'mison_payroll', 'mison_kpi_programs', 'mison_create_receipt', 'mison_order_create', 'mison_reservation_create', 'mison_attendance_mark', 'mison_inventory_preview', 'mison_create_inventory', 'mison_get_inventory', 'mison_inventory_balances', 'mison_transfer_internal', 'mison_transfer_external', 'mison_transfer_recipients', 'mison_transfer_stock', 'mison_get_transfer']) {
		assert.ok(names.includes(required), `нет ${required}`)
	}

	const receipt = tools.find((tool) => tool.name === 'mison_create_receipt')
	assert.ok(receipt.inputSchema.properties.confirmed, 'у записи есть confirmed')
	assert.equal(receipt.annotations.readOnlyHint, false)
	assert.equal(tools.find((tool) => tool.name === 'mison_payroll').annotations.readOnlyHint, true)
	assert.equal(tools.find((tool) => tool.name === 'mison_order_cancel').annotations.destructiveHint, true)
	for (const tool of tools) assert.ok(tool.description.length > 30, `описание ${tool.name}`)

	await client.close()
})

test('MISON_MCP_READONLY убирает инструменты записи', async () => {
	const client = await connect({ MISON_MCP_READONLY: 'true' })
	const { tools } = await client.listTools()
	const names = tools.map((tool) => tool.name)
	assert.ok(names.includes('mison_payroll'))
	for (const writeName of ['mison_create_receipt', 'mison_create_inventory', 'mison_transfer_internal', 'mison_transfer_external', 'mison_order_create', 'mison_order_cancel', 'mison_reservation_create', 'mison_attendance_mark']) {
		assert.ok(!names.includes(writeName), `${writeName} не должен быть доступен`)
	}
	await client.close()
})

test('MISON_MCP_GROUPS оставляет core и выбранные группы', async () => {
	const client = await connect({ MISON_MCP_GROUPS: 'receipts' })
	const names = (await client.listTools()).tools.map((tool) => tool.name)
	assert.ok(names.includes('mison_points'), 'core всегда')
	assert.ok(names.includes('mison_create_receipt'))
	assert.ok(!names.includes('mison_payroll'))
	assert.ok(!names.includes('mison_order_create'))
	await client.close()
})

test('параметры чтения уходят в query, массивы — через запятую, пустые отбрасываются', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({
		name: 'mison_cheques',
		arguments: { status: 'closed', date_from: '2026-10-18', date_to: '2026-10-18', order_type_ids: [1, 3], limit: 5, with_items: true },
	})
	assert.ok(!result.isError)
	const request = mock.state.requests.find((item) => item.path === '/reports/cheques')
	assert.deepEqual(request.query, { status: 'closed', date_from: '2026-10-18', date_to: '2026-10-18', order_type_ids: '1,3', limit: '5', with_items: 'true' })
	await client.close()
})

test('история гостя: client_phone уходит в query как есть', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({ name: 'mison_cheques', arguments: { client_phone: '+998 90 249-77-79', limit: 3 } })
	assert.ok(!result.isError)
	const request = mock.state.requests.find((item) => item.path === '/reports/cheques')
	assert.deepEqual(request.query, { client_phone: '+998 90 249-77-79', limit: '3' })
	await client.close()
})

test('OLAP уходит телом POST', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	await client.callTool({
		name: 'mison_olap_report',
		arguments: { report_type: 'SALES', date_from: '2026-10-01', date_to: '2026-10-07', measures: ['net_amount'], filters: { point_ids: ['p-1'] }, include_totals: true },
	})
	const request = mock.state.requests.find((item) => item.path === '/reports/olap')
	assert.equal(request.method, 'POST')
	assert.deepEqual(request.body.filters, { point_ids: ['p-1'] })
	assert.equal(request.body.include_totals, true)
	await client.close()
})

test('токен берётся один раз и переиспользуется; при 401 обновляется и запрос повторяется', async () => {
	const client = await connect()
	const before = mock.state.tokenCalls
	await client.callTool({ name: 'mison_points', arguments: {} })
	await client.callTool({ name: 'mison_points', arguments: {} })
	assert.equal(mock.state.tokenCalls - before, 1, 'токен запрошен один раз')

	mock.state.expireTokens = true
	mock.state.currentToken = 'tok-rotated-on-server'
	const result = await client.callTool({ name: 'mison_points', arguments: {} })
	assert.ok(!result.isError, textOf(result))
	assert.match(textOf(result), /Чиланзар/)
	assert.equal(mock.state.tokenCalls - before, 2, 'после 401 запрошен новый токен')
	await client.close()
})

test('429: ждёт retry_after и повторяет', async () => {
	const client = await connect()
	mock.state.rateLimitNext = true
	const started = Date.now()
	const result = await client.callTool({ name: 'mison_points', arguments: {} })
	assert.ok(!result.isError, textOf(result))
	assert.ok(Date.now() - started >= 900, 'выдержал паузу')
	await client.close()
})

test('ошибки API превращаются в понятный текст с подсказкой', async () => {
	const client = await connect()
	const forbidden = await client.callTool({ name: 'mison_profit_loss', arguments: { date_from: '2026-10-01', date_to: '2026-10-07' } })
	assert.equal(forbidden.isError, true)
	assert.match(textOf(forbidden), /\(403\).*нет доступа к отчётам/s)
	assert.match(textOf(forbidden), /Интеграции → API-ключи/)

	const notFound = await client.callTool({ name: 'mison_order_status', arguments: { order_id: 777 } })
	assert.equal(notFound.isError, true)
	assert.match(textOf(notFound), /\(404\).*Заказ не найден/s)
	await client.close()
})

test('валидация параметров: неверная дата отклоняется до запроса', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({ name: 'mison_payroll', arguments: { date_from: '01.10.2026', date_to: '2026-10-07' } })
	assert.equal(result.isError, true)
	assert.equal(mock.state.requests.length, 0)
	await client.close()
})

test('запись без confirmed ничего не отправляет и возвращает итог с external_id', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({
		name: 'mison_create_receipt',
		arguments: { point_id: 'p-1', warehouse_id: 412, supplier_id: 87, items: [{ product_id: 5120, quantity: 24, price: 15000 }] },
	})
	assert.ok(!result.isError)
	assert.match(textOf(result), /НЕ ОТПРАВЛЕНО/)
	assert.match(textOf(result), /Итого: 360\s?000/)
	assert.match(textOf(result), /external_id=mcp-/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/receipts').length, 0, 'запрос не уходил')
	await client.close()
})

test('запись с confirmed уходит с external_id; повтор не плодит дублей', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const args = { point_id: 'p-1', warehouse_id: 412, supplier_id: 87, items: [{ product_id: 5120, quantity: 24, price: 15000 }], external_id: 'TG-1', confirmed: true }

	const first = await client.callTool({ name: 'mison_create_receipt', arguments: args })
	const second = await client.callTool({ name: 'mison_create_receipt', arguments: args })
	assert.ok(!first.isError, textOf(first))
	assert.match(textOf(first), /"duplicate":false/)
	assert.match(textOf(second), /"duplicate":true/)

	const posted = mock.state.requests.filter((item) => item.path === '/receipts')
	assert.equal(posted[0].body.external_id, 'TG-1')
	assert.equal(posted[0].body.confirmed, undefined, 'confirmed на сервер не уходит')
	await client.close()
})

test('идентификатор создаётся сам, а при сбое 500 запрос повторяется с тем же', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	mock.state.failNextReceiptWith500 = true
	const result = await client.callTool({
		name: 'mison_create_receipt',
		arguments: { point_id: 'p-1', warehouse_id: 412, supplier_id: 87, items: [{ product_id: 5120, quantity: 1, price: 100 }], confirmed: true },
	})
	assert.ok(!result.isError, textOf(result))
	const posted = mock.state.requests.filter((item) => item.path === '/receipts')
	assert.equal(posted.length, 2, 'после 500 был повтор')
	assert.match(posted[0].body.external_id, /^mcp-/)
	assert.equal(posted[0].body.external_id, posted[1].body.external_id, 'повтор с тем же идентификатором')
	await client.close()
})

test('409 при отмене приходит как ошибка с текстом сервера и не повторяется', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({ name: 'mison_order_cancel', arguments: { order_id: 778, confirmed: true } })
	assert.equal(result.isError, true)
	assert.match(textOf(result), /\(409\).*только через кассу/s)
	assert.equal(mock.state.requests.filter((item) => item.path === '/orders/778/cancel').length, 1)
	await client.close()
})

test('огромный ответ обрезается с пометкой, итог сохраняется', async () => {
	const client = await connect()
	const result = await client.callTool({ name: 'mison_stock', arguments: {} })
	assert.ok(!result.isError)
	const text = textOf(result)
	assert.ok(text.length <= 60000, `длина ${text.length}`)
	const data = JSON.parse(text)
	assert.equal(data._mcp_truncated.field, 'rows')
	assert.equal(data._mcp_truncated.total, 20000)
	assert.ok(data._mcp_truncated.shown < 20000)
	assert.deepEqual(data.totals, { quantity: 1 })
	await client.close()
})

test('ok(): маленький ответ не трогается', () => {
	assert.equal(ok({ a: 1 }).content[0].text, '{"a":1}')
})

test('без MISON_API_KEY сервер не стартует и объясняет почему', () => {
	const env = { ...process.env }
	delete env.MISON_API_KEY
	const run = spawnSync(process.execPath, [ENTRY], { env, encoding: 'utf8', timeout: 10000 })
	assert.notEqual(run.status, 0)
	assert.match(run.stderr, /MISON_API_KEY/)
})

test('неверная группа в MISON_MCP_GROUPS — понятная ошибка', () => {
	const run = spawnSync(process.execPath, [ENTRY], { env: { ...process.env, MISON_API_KEY: 'x', MISON_MCP_GROUPS: 'reports,foo' }, encoding: 'utf8', timeout: 10000 })
	assert.notEqual(run.status, 0)
	assert.match(run.stderr, /неизвестные группы foo/)
})

test('группа inventories: общие склады и товары есть, поставщиков и прихода нет', async () => {
	const client = await connect({ MISON_MCP_GROUPS: 'inventories' })
	const names = (await client.listTools()).tools.map((tool) => tool.name)
	for (const required of ['mison_points', 'mison_inventory_balances', 'mison_inventory_preview', 'mison_create_inventory', 'mison_get_inventory', 'mison_receipt_warehouses', 'mison_receipt_products']) {
		assert.ok(names.includes(required), `нет ${required}`)
	}
	assert.ok(!names.includes('mison_receipt_suppliers'))
	assert.ok(!names.includes('mison_create_receipt'))
	await client.close()
})

test('приход: is_draft уходит на сервер, итог для подтверждения говорит «черновик»', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const args = { point_id: 'p-1', warehouse_id: 412, supplier_id: 87, items: [{ product_id: 5120, quantity: 2, price: 100 }], is_draft: true }
	const preview = await client.callTool({ name: 'mison_create_receipt', arguments: args })
	assert.match(textOf(preview), /ЧЕРНОВИК/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/receipts').length, 0)

	await client.callTool({ name: 'mison_create_receipt', arguments: { ...args, confirmed: true } })
	assert.equal(mock.state.requests.find((item) => item.path === '/receipts').body.is_draft, true)
	await client.close()
})

test('инвентаризация: без confirmed — итог «черновик», на сервер ничего не уходит', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({
		name: 'mison_create_inventory',
		arguments: { point_id: 'p-1', warehouse_id: 901, items: [{ product_id: 240285, actual_quantity: 20 }] },
	})
	assert.ok(!result.isError)
	assert.match(textOf(result), /НЕ ОТПРАВЛЕНО/)
	assert.match(textOf(result), /ЧЕРНОВИК/)
	assert.match(textOf(result), /external_id=mcp-/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/inventories').length, 0)
	await client.close()
})

test('инвентаризация: по умолчанию уходит черновик (is_draft: true)', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({
		name: 'mison_create_inventory',
		arguments: { point_id: 'p-1', warehouse_id: 901, items: [{ product_id: 240285, actual_quantity: 20 }], external_id: 'INV-1', confirmed: true },
	})
	assert.ok(!result.isError, textOf(result))
	assert.match(textOf(result), /"status":"draft"/)
	const sent = mock.state.requests.find((item) => item.path === '/inventories')
	assert.equal(sent.body.is_draft, true)
	assert.equal(sent.body.confirmed, undefined)
	await client.close()
})

test('инвентаризация: проведение сразу без check отклоняется до запроса', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({
		name: 'mison_create_inventory',
		arguments: { point_id: 'p-1', warehouse_id: 901, items: [{ product_id: 240285, actual_quantity: 20 }], is_draft: false, confirmed: true },
	})
	assert.equal(result.isError, true)
	assert.match(textOf(result), /нужен check/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/inventories').length, 0)
	await client.close()
})

test('инвентаризация: проведение сразу с check уходит; 409 возвращает новые цифры', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const base = { point_id: 'p-1', warehouse_id: 901, items: [{ product_id: 240285, actual_quantity: 20 }], is_draft: false, confirmed: true }

	const posted = await client.callTool({ name: 'mison_create_inventory', arguments: { ...base, check: 'chk-1', external_id: 'INV-2' } })
	assert.ok(!posted.isError, textOf(posted))
	assert.match(textOf(posted), /"status":"posted"/)
	assert.equal(mock.state.requests.find((item) => item.path === '/inventories').body.check, 'chk-1')

	const stale = await client.callTool({ name: 'mison_create_inventory', arguments: { ...base, check: 'stale', external_id: 'INV-3' } })
	assert.equal(stale.isError, true)
	assert.match(textOf(stale), /(409)/)
	assert.match(textOf(stale), /balance_changed/)
	assert.match(textOf(stale), /85500/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/inventories' && item.body.external_id === 'INV-3').length, 1, '409 не повторяется')
	await client.close()
})

test('инвентаризация: расчёт и остатки идут запросами чтения', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const preview = await client.callTool({
		name: 'mison_inventory_preview',
		arguments: { point_id: 'p-1', warehouse_id: 901, items: [{ product_id: 1, actual_quantity: 5 }] },
	})
	assert.match(textOf(preview), /"check":"chk-1"/)
	await client.callTool({ name: 'mison_inventory_balances', arguments: { point_id: 'p-1', warehouse_id: 901, search: 'виш', only_with_balance: true } })
	const balances = mock.state.requests.find((item) => item.path === '/inventories/balances')
	assert.deepEqual(balances.query, { point_id: 'p-1', warehouse_id: '901', search: 'виш', only_with_balance: 'true' })
	await client.close()
})

test('группа transfers: свои инструменты и общие склады с товарами, без прихода и инвентаризации', async () => {
	const client = await connect({ MISON_MCP_GROUPS: 'transfers' })
	const names = (await client.listTools()).tools.map((tool) => tool.name)
	for (const required of ['mison_points', 'mison_transfer_recipients', 'mison_transfer_stock', 'mison_transfer_internal', 'mison_transfer_external', 'mison_get_transfer', 'mison_receipt_warehouses', 'mison_receipt_products']) {
		assert.ok(names.includes(required), `нет ${required}`)
	}
	assert.ok(!names.includes('mison_create_receipt'))
	assert.ok(!names.includes('mison_create_inventory'))
	await client.close()
})

test('перемещение между складами: без confirmed ничего не уходит, с confirmed — уходит с external_id', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const args = { point_id: 'p-1', from_warehouse_id: 926, to_warehouse_id: 927, items: [{ product_id: 246343, quantity: 2 }] }

	const preview = await client.callTool({ name: 'mison_transfer_internal', arguments: args })
	assert.match(textOf(preview), /НЕ ОТПРАВЛЕНО/)
	assert.match(textOf(preview), /ПРОВЕДЕНО СРАЗУ/)
	assert.match(textOf(preview), /external_id=mcp-/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/transfers/internal').length, 0)

	const done = await client.callTool({ name: 'mison_transfer_internal', arguments: { ...args, confirmed: true, external_id: 'TR-1' } })
	assert.ok(!done.isError, textOf(done))
	assert.match(textOf(done), /"status":"posted"/)
	const sent = mock.state.requests.find((item) => item.path === '/transfers/internal')
	assert.equal(sent.body.external_id, 'TR-1')
	assert.equal(sent.body.confirmed, undefined)
	await client.close()
})

test('перемещение между складами: нехватка остатка приходит как 409 с данными и не повторяется', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const result = await client.callTool({
		name: 'mison_transfer_internal',
		arguments: { point_id: 'p-1', from_warehouse_id: 926, to_warehouse_id: 927, items: [{ product_id: 246343, quantity: 500 }], confirmed: true, external_id: 'TR-2' },
	})
	assert.equal(result.isError, true)
	assert.match(textOf(result), /\(409\)/)
	assert.match(textOf(result), /insufficient_stock/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/transfers/internal').length, 1)
	await client.close()
})

test('внешнее перемещение: по умолчанию черновик, отправка — только явным is_draft=false', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const base = { point_id: 'p-1', from_warehouse_id: 926, to_point_id: 'rec-1', to_warehouse_id: 460, items: [{ product_id: 246346, quantity: 1, sale_price: 12000 }] }

	const draftPreview = await client.callTool({ name: 'mison_transfer_external', arguments: base })
	assert.match(textOf(draftPreview), /ЧЕРНОВИК/)

	const draft = await client.callTool({ name: 'mison_transfer_external', arguments: { ...base, confirmed: true, external_id: 'EX-1' } })
	assert.match(textOf(draft), /"status":"draft"/)
	assert.equal(mock.state.requests.find((item) => item.body?.external_id === 'EX-1').body.is_draft, true)

	const sendPreview = await client.callTool({ name: 'mison_transfer_external', arguments: { ...base, is_draft: false } })
	assert.match(textOf(sendPreview), /ОТПРАВЛЕН СРАЗУ/)
	assert.match(textOf(sendPreview), /долг/)

	const sent = await client.callTool({ name: 'mison_transfer_external', arguments: { ...base, is_draft: false, confirmed: true, external_id: 'EX-2' } })
	assert.match(textOf(sent), /"status":"sent"/)
	assert.equal(mock.state.requests.find((item) => item.body?.external_id === 'EX-2').body.is_draft, false)
	await client.close()
})

test('перемещения: справочники и чтение идут запросами чтения', async () => {
	const client = await connect()
	mock.state.requests.length = 0
	const recipients = await client.callTool({ name: 'mison_transfer_recipients', arguments: { point_id: 'p-1' } })
	assert.match(textOf(recipients), /rec-1/)
	await client.callTool({ name: 'mison_transfer_stock', arguments: { point_id: 'p-1', warehouse_id: 926, search: 'масл', only_with_balance: true } })
	assert.deepEqual(mock.state.requests.find((item) => item.path === '/transfers/stock').query, { point_id: 'p-1', warehouse_id: '926', search: 'масл', only_with_balance: 'true' })
	await client.callTool({ name: 'mison_get_transfer', arguments: { external_id: 'EX-2' } })
	assert.deepEqual(mock.state.requests.find((item) => item.path === '/transfers' && item.method === 'GET').query, { external_id: 'EX-2' })
	await client.close()
})
