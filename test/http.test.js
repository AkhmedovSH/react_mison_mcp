import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startMockApi } from './mock-api.js'
import { createHttpServer, loadConfig } from '../src/http.js'

let mock

before(async () => {
	mock = await startMockApi()
})
after(async () => {
	await mock.close()
})

// Поднимает HTTP-сервер MCP на свободном порту, смотрящий на мок-API
async function startHttp(env = {}) {
	const config = loadConfig({ MISON_API_URL: mock.url, MISON_MCP_LOG: 'off', ...env })
	const server = createHttpServer({ config })
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${server.address().port}`
	return {
		base,
		url: `${base}/mcp`,
		close: () => new Promise((done) => {
			server.closeAllConnections?.()
			server.close(done)
		}),
	}
}

async function connect(url, headers = { Authorization: 'Bearer good-key' }) {
	const client = new Client({ name: 'test', version: '0' })
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
	return client
}

const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params })
const post = (url, body, headers = {}) =>
	fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
const textOf = (result) => result.content.map((part) => part.text).join('\n')
const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })

test('подключение по HTTP с ключом в Bearer: список инструментов и вызов', async () => {
	const app = await startHttp()
	const client = await connect(app.url)

	const { tools } = await client.listTools()
	assert.ok(tools.length >= 55, `инструментов ${tools.length}`)
	const names = tools.map((tool) => tool.name)
	for (const required of ['mison_points', 'mison_create_receipt', 'mison_create_inventory', 'mison_transfer_external']) {
		assert.ok(names.includes(required), `нет ${required}`)
	}

	const result = await client.callTool({ name: 'mison_points', arguments: {} })
	assert.ok(!result.isError, textOf(result))
	assert.match(textOf(result), /Чиланзар/)

	await client.close()
	await app.close()
})

test('без заголовка Authorization — 401 с понятным текстом и WWW-Authenticate', async () => {
	const app = await startHttp()
	const response = await post(app.url, INIT)
	assert.equal(response.status, 401)
	assert.match(response.headers.get('www-authenticate'), /Bearer/)
	const body = await response.json()
	assert.match(body.error.message, /Authorization: Bearer/)
	await app.close()
})

test('неверный ключ на подключении — 401 invalid_token, Mison вызывается один раз на ключ', async () => {
	const app = await startHttp()
	const before = mock.state.tokenCalls
	const response = await post(app.url, INIT, { Authorization: 'Bearer wrong-key-1234' })
	assert.equal(response.status, 401)
	assert.match(response.headers.get('www-authenticate'), /invalid_token/)
	assert.match((await response.json()).error.message, /не принял API-ключ/)
	assert.equal(mock.state.tokenCalls - before, 1)
	await app.close()
})

test('вызов инструмента с неверным ключом без подключения — ошибка 401 текстом, а не падение', async () => {
	const app = await startHttp()
	const response = await post(app.url, rpc('tools/call', { name: 'mison_points', arguments: {} }), { Authorization: 'Bearer wrong-key-5678' })
	assert.equal(response.status, 200)
	const body = await response.json()
	assert.equal(body.result.isError, true)
	assert.match(textOf(body.result), /\(401\)/)
	await app.close()
})

test('токен кэшируется по ключу: несколько подключений — один обмен ключа на токен', async () => {
	const app = await startHttp()
	mock.state.tokenCallsByKey = {}

	for (let i = 0; i < 3; i++) {
		const client = await connect(app.url)
		await client.callTool({ name: 'mison_points', arguments: {} })
		await client.close()
	}
	assert.equal(mock.state.tokenCallsByKey['good-key'], 1, 'токен запрошен один раз')
	await app.close()
})

test('параллельные запросы одного ключа ждут один обмен токена', async () => {
	const app = await startHttp()
	mock.state.tokenCallsByKey = {}
	await Promise.all(Array.from({ length: 6 }, () => post(app.url, INIT, { Authorization: 'Bearer other-key' })))
	assert.equal(mock.state.tokenCallsByKey['other-key'], 1)
	await app.close()
})

test('ключи изолированы: запросы второго ключа идут со своим токеном', async () => {
	const app = await startHttp()
	mock.state.requestsByToken = {}

	const a = await connect(app.url, { Authorization: 'Bearer good-key' })
	const b = await connect(app.url, { Authorization: 'Bearer other-key' })
	await a.callTool({ name: 'mison_points', arguments: {} })
	await b.callTool({ name: 'mison_points', arguments: {} })

	assert.ok(mock.state.requestsByToken[mock.state.currentToken] >= 1)
	assert.equal(mock.state.requestsByToken['tok-other'], 1)
	await a.close()
	await b.close()
	await app.close()
})

test('заголовки сужают набор: X-Mison-Readonly и X-Mison-Groups', async () => {
	const app = await startHttp()

	const readonly = await connect(app.url, { Authorization: 'Bearer good-key', 'X-Mison-Readonly': 'true' })
	const readonlyNames = (await readonly.listTools()).tools.map((tool) => tool.name)
	assert.ok(readonlyNames.includes('mison_payroll'))
	for (const writeName of ['mison_create_receipt', 'mison_create_inventory', 'mison_transfer_internal', 'mison_order_create']) {
		assert.ok(!readonlyNames.includes(writeName), `${writeName} не должен быть доступен`)
	}
	await readonly.close()

	const groups = await connect(app.url, { Authorization: 'Bearer good-key', 'X-Mison-Groups': 'receipts' })
	const groupNames = (await groups.listTools()).tools.map((tool) => tool.name)
	assert.ok(groupNames.includes('mison_points'), 'core всегда')
	assert.ok(groupNames.includes('mison_create_receipt'))
	assert.ok(!groupNames.includes('mison_payroll'))
	await groups.close()

	const bad = await post(app.url, rpc('tools/list'), { Authorization: 'Bearer good-key', 'X-Mison-Groups': 'reports,foo' })
	assert.equal(bad.status, 400)
	assert.match((await bad.json()).error.message, /неизвестные группы foo/)
	await app.close()
})

test('настройки сервера — потолок: при MISON_MCP_READONLY клиент запись не получит', async () => {
	const app = await startHttp({ MISON_MCP_READONLY: 'true', MISON_MCP_GROUPS: 'reports,receipts' })
	const client = await connect(app.url, { Authorization: 'Bearer good-key', 'X-Mison-Readonly': 'false', 'X-Mison-Groups': 'reports,receipts,orders' })
	const names = (await client.listTools()).tools.map((tool) => tool.name)
	assert.ok(names.includes('mison_payroll'))
	assert.ok(!names.includes('mison_create_receipt'), 'запись отключена сервером')
	assert.ok(!names.includes('mison_order_create'), 'группа вне потолка сервера')
	await client.close()
	await app.close()
})

test('запись по HTTP: без confirmed ничего не уходит, с confirmed — уходит', async () => {
	const app = await startHttp()
	const client = await connect(app.url)
	mock.state.requests.length = 0
	const args = { point_id: 'p-1', warehouse_id: 412, supplier_id: 87, items: [{ product_id: 5120, quantity: 2, price: 100 }], external_id: 'HTTP-1' }

	const preview = await client.callTool({ name: 'mison_create_receipt', arguments: args })
	assert.match(textOf(preview), /НЕ ОТПРАВЛЕНО/)
	assert.equal(mock.state.requests.filter((item) => item.path === '/receipts').length, 0)

	const done = await client.callTool({ name: 'mison_create_receipt', arguments: { ...args, confirmed: true } })
	assert.ok(!done.isError, textOf(done))
	assert.equal(mock.state.requests.filter((item) => item.path === '/receipts').length, 1)

	await client.close()
	await app.close()
})

test('GET /mcp — 405, /health — 200, чужой путь — 404', async () => {
	const app = await startHttp()
	const get = await fetch(app.url)
	assert.equal(get.status, 405)
	assert.match(get.headers.get('allow'), /POST/)

	const health = await fetch(`${app.base}/health`)
	assert.equal(health.status, 200)
	const body = await health.json()
	assert.equal(body.ok, true)
	assert.ok(body.version)

	assert.equal((await fetch(`${app.base}/nope`)).status, 404)
	await app.close()
})

test('CORS: только для перечисленных источников', async () => {
	const app = await startHttp({ MISON_MCP_ALLOWED_ORIGINS: 'https://inspector.example' })
	const allowed = await fetch(app.url, { method: 'OPTIONS', headers: { Origin: 'https://inspector.example' } })
	assert.equal(allowed.status, 204)
	assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://inspector.example')

	const denied = await fetch(app.url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })
	assert.equal(denied.headers.get('access-control-allow-origin'), null)
	await app.close()
})

test('слишком большое тело — 413, не JSON — 400', async () => {
	const app = await startHttp({ MISON_MCP_MAX_BODY: '2000' })
	const huge = await post(app.url, JSON.stringify({ pad: 'x'.repeat(5000) }), { Authorization: 'Bearer good-key' })
	assert.equal(huge.status, 413)

	const broken = await post(app.url, 'это не json', { Authorization: 'Bearer good-key' })
	assert.equal(broken.status, 400)
	await app.close()
})

test('лимит запросов на ключ: после превышения — 429 с Retry-After', async () => {
	const app = await startHttp({ MISON_MCP_HTTP_RATE_LIMIT: '3' })
	const statuses = []
	let last
	for (let i = 0; i < 5; i++) {
		last = await post(app.url, rpc('tools/list', {}, i), { Authorization: 'Bearer good-key' })
		statuses.push(last.status)
	}
	assert.deepEqual(statuses.slice(0, 3), [200, 200, 200])
	assert.equal(statuses[3], 429)
	assert.ok(Number(last.headers.get('retry-after')) >= 1)

	// Другой ключ лимитом первого не затронут
	const other = await post(app.url, rpc('tools/list'), { Authorization: 'Bearer other-key' })
	assert.equal(other.status, 200)
	await app.close()
})

test('перебор ключей: после неудач с одного адреса — 429 без обращения к Mison', async () => {
	const app = await startHttp({ MISON_MCP_HTTP_AUTH_FAIL_LIMIT: '2' })
	const before = mock.state.tokenCalls

	assert.equal((await post(app.url, INIT, { Authorization: 'Bearer bad-key-0001' })).status, 401)
	assert.equal((await post(app.url, INIT, { Authorization: 'Bearer bad-key-0002' })).status, 401)
	// Лимит исчерпан двумя неудачами; следующая попытка (даже с верным ключом) отсекается
	const blocked = await post(app.url, INIT, { Authorization: 'Bearer bad-key-0003' })
	assert.equal(blocked.status, 429)
	assert.equal(mock.state.tokenCalls - before, 2, 'Mison не дергали')
	await app.close()
})

test('ключ не попадает в журнал: только отпечаток', async () => {
	const lines = []
	const original = console.error
	console.error = (...args) => lines.push(args.join(' '))
	try {
		const app = await startHttp({ MISON_MCP_LOG: 'on' })
		const client = await connect(app.url, { Authorization: 'Bearer good-key' })
		await client.callTool({ name: 'mison_points', arguments: {} })
		await client.close()
		await app.close()
	} finally {
		console.error = original
	}

	const joined = lines.join('\n')
	assert.ok(joined.includes('"tool":"mison_points"'), 'журнал пишет имя инструмента')
	assert.ok(!joined.includes('good-key'), 'сам ключ в журнале не должен быть')
	assert.match(joined, /"key":"[0-9a-f]{8}"/)
})
