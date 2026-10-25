// Мок партнёрского API Mison для проверки MCP-сервера без боевого ключа.

import http from 'node:http'

export function startMockApi() {
	const state = {
		tokenCalls: 0,
		requests: [],
		receipts: new Map(),
		failNextReceiptWith500: false,
		rateLimitNext: false,
		expireTokens: false,
		currentToken: 'tok-1',
		tokenCallsByKey: {},
		requestsByToken: {},
	}

	const server = http.createServer((req, res) => {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			const body = raw ? JSON.parse(raw) : null
			const url = new URL(req.url, 'http://mock')
			const path = url.pathname.replace('/api/integrations/v1', '')
			const send = (status, data) => {
				res.writeHead(status, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(data))
			}

			if (path === '/auth/token' && req.method === 'POST') {
				state.tokenCalls += 1
				state.tokenCallsByKey[body?.api_key] = (state.tokenCallsByKey[body?.api_key] || 0) + 1
				if (body?.api_key === 'other-key') return send(200, { access_token: 'tok-other', token_type: 'Bearer', expires_in: 2592000 })
				if (body?.api_key !== 'good-key') return send(401, { message: 'Неверный api_key' })
				if (state.expireTokens) {
					state.currentToken = `tok-${state.tokenCalls + 1}`
					state.expireTokens = false
				}
				return send(200, { access_token: state.currentToken, token_type: 'Bearer', expires_in: 2592000 })
			}

			const auth = req.headers.authorization
			if (auth !== `Bearer ${state.currentToken}` && auth !== 'Bearer tok-other') return send(401, { message: 'Неверный или просроченный access_token' })
			state.requestsByToken[auth.slice(7)] = (state.requestsByToken[auth.slice(7)] || 0) + 1

			state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body })

			if (state.rateLimitNext) {
				state.rateLimitNext = false
				return send(429, { message: 'Слишком много запросов', retry_after: 1 })
			}

			if (path === '/points') return send(200, { points: [{ id: 'p-1', name: 'Чиланзар' }] })
			if (path === '/reports/payroll') return send(200, { echo: Object.fromEntries(url.searchParams), employees: [] })
			if (path === '/reports/cheques') return send(200, { echo: Object.fromEntries(url.searchParams), cheques: [] })
			if (path === '/reports/olap') return send(200, { echo: body, rows: [] })
			if (path === '/reports/big') return send(200, {})
			if (path === '/reports/profit-loss') return send(403, { message: 'У ключа нет доступа к отчётам. Включите его в кабинете' })
			if (path === '/reports/stock') {
				return send(200, { totals: { quantity: 1 }, rows: Array.from({ length: 20000 }, (_, i) => ({ product_id: i, name: 'Товар ' + i, quantity: i })) })
			}
			if (path === '/orders/777' && req.method === 'GET') return send(404, { message: 'Заказ не найден' })
			if (path === '/orders/778/cancel') return send(409, { message: 'Заказ уже принят на точке, отмена возможна только через кассу' })

			if (path === '/transfers/recipients') return send(200, { echo: Object.fromEntries(url.searchParams), recipients: [{ recipient_id: 'rec-1', name: 'Партнёр', warehouses: [{ warehouse_id: 460, name: 'Склад' }] }] })
			if (path === '/transfers/stock') return send(200, { echo: Object.fromEntries(url.searchParams), items: [] })
			if (path === '/transfers/internal' && req.method === 'POST') {
				if (body.items[0].quantity > 100) {
					return send(409, { message: 'Не хватает остатка на складе-источнике', code: 'insufficient_stock', shortages: [{ product_id: body.items[0].product_id, balance: 1, requested: body.items[0].quantity }] })
				}
				return send(201, { external_id: body.external_id, transfer_id: 11, kind: 'internal', status: 'posted', duplicate: false })
			}
			if (path === '/transfers/external' && req.method === 'POST') {
				return send(201, { external_id: body.external_id, transfer_id: 12, kind: 'external', status: body.is_draft === false ? 'sent' : 'draft', duplicate: false })
			}
			if (path === '/transfers' && req.method === 'GET') return send(200, { echo: Object.fromEntries(url.searchParams), kind: 'external', status: 'sent' })
			if (path === '/inventories/balances') return send(200, { echo: Object.fromEntries(url.searchParams), items: [] })
			if (path === '/inventories/preview' && req.method === 'POST') {
				return send(200, { lines: [], totals: { shortage_amount: 70500 }, check: 'chk-1', drift_product_ids: [] })
			}
			if (path === '/inventories' && req.method === 'POST') {
				if (body.is_draft === false && body.check === 'stale') {
					return send(409, { message: 'Остатки или цены изменились с момента расчёта', code: 'balance_changed', current: { check: 'chk-2', totals: { shortage_amount: 85500 } } })
				}
				return send(201, { external_id: body.external_id, inventory_id: 7, status: body.is_draft === false ? 'posted' : 'draft', duplicate: false })
			}
			if (path === '/receipts' && req.method === 'POST') {
				if (state.failNextReceiptWith500) {
					state.failNextReceiptWith500 = false
					return send(500, { message: 'Не удалось сохранить приход, повторите запрос' })
				}
				const known = state.receipts.get(body.external_id)
				if (known) return send(200, { ...known, duplicate: true })
				const created = { external_id: body.external_id, receipt_id: 100 + state.receipts.size, duplicate: false, status: 'posted' }
				state.receipts.set(body.external_id, created)
				return send(201, created)
			}

			return send(404, { message: `нет маршрута ${req.method} ${path}` })
		})
	})

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve({
				state,
				url: `http://127.0.0.1:${server.address().port}/api/integrations/v1`,
				close: () => new Promise((done) => server.close(done)),
			})
		})
	})
}
