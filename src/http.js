#!/usr/bin/env node
// Удалённый MCP-сервер Mison по HTTP (Streamable HTTP, без сессий).
//
// Ключ клиента — в заголовке `Authorization: Bearer <api-ключ Mison>`: на каждый запрос сервер собирает
// инструменты под этот ключ и вызывает партнёрское API от его имени. Ключ нигде не хранится и не
// печатается (в журнале — первые 8 знаков его sha256); токены Mison кэшируются в памяти по отпечатку ключа.
//
// Работает за nginx (TLS снаружи) на 127.0.0.1. Настройки — переменные окружения, см. loadConfig().

import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { MisonClient, MisonError, TokenCache, DEFAULT_BASE_URL, keyHash } from './client.js'
import { GROUPS } from './tools/define.js'
import { parseGroups } from './tools/index.js'
import { createMisonServer, VERSION } from './server.js'

const MCP_PATH = '/mcp'

export function loadConfig(env = process.env) {
	const flag = (value) => /^(1|true|yes)$/i.test(value || '')
	const number = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback)

	return {
		port: number(env.PORT, 3300),
		// За nginx слушаем только локальный интерфейс
		host: env.HOST || '127.0.0.1',
		baseUrl: env.MISON_API_URL || DEFAULT_BASE_URL,
		// Потолок возможностей сервера: клиент может только сузить его заголовками
		groups: parseGroups(env.MISON_MCP_GROUPS),
		readonly: flag(env.MISON_MCP_READONLY),
		// Запросов в минуту на один ключ
		rateLimit: number(env.MISON_MCP_HTTP_RATE_LIMIT, 300),
		// Неудачных попыток входа в минуту с одного адреса
		authFailLimit: number(env.MISON_MCP_HTTP_AUTH_FAIL_LIMIT, 30),
		// За nginx настоящий адрес клиента — первый в X-Forwarded-For
		trustProxy: flag(env.MISON_MCP_TRUST_PROXY),
		allowedOrigins: (env.MISON_MCP_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean),
		maxBodyBytes: number(env.MISON_MCP_MAX_BODY, 1_000_000),
		log: !/^(0|false|off|no)$/i.test(env.MISON_MCP_LOG || ''),
	}
}

/** Фиксированное окно: не больше limit попаданий на ключ за windowMs */
export class RateLimiter {
	#limit
	#windowMs
	#entries = new Map()

	constructor(limit, windowMs = 60_000) {
		this.#limit = limit
		this.#windowMs = windowMs
		this.#cleaner = setInterval(() => this.#sweep(), windowMs)
		this.#cleaner.unref()
	}

	#cleaner

	#sweep() {
		const now = Date.now()
		for (const [key, entry] of this.#entries) if (entry.resetAt <= now) this.#entries.delete(key)
	}

	/** Засчитывает попадание; allowed=false — лимит исчерпан, retryAfter — через сколько секунд окно сбросится */
	hit(key) {
		const now = Date.now()
		let entry = this.#entries.get(key)
		if (!entry || entry.resetAt <= now) {
			entry = { count: 0, resetAt: now + this.#windowMs }
			this.#entries.set(key, entry)
		}
		entry.count += 1
		return { allowed: entry.count <= this.#limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
	}

	/** Узнать состояние, не засчитывая попадание */
	peek(key) {
		const entry = this.#entries.get(key)
		if (!entry || entry.resetAt <= Date.now()) return { allowed: true, retryAfter: 0 }
		return { allowed: entry.count < this.#limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) }
	}

	stop() {
		clearInterval(this.#cleaner)
	}
}

class HttpError extends Error {
	constructor(status, message, headers = {}) {
		super(message)
		this.status = status
		this.headers = headers
	}
}

function sendJson(res, status, body, headers = {}) {
	if (res.headersSent) return
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
	res.end(JSON.stringify(body))
}

// Ошибка в формате JSON-RPC: клиенты MCP показывают message пользователю
function sendRpcError(res, status, message, headers = {}) {
	sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null }, headers)
}

function bearerKey(req) {
	const match = /^Bearer\s+(\S{8,200})$/i.exec(req.headers.authorization || '')
	return match ? match[1] : null
}

async function readJson(req, maxBytes) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > maxBytes) throw new HttpError(413, 'Слишком большой запрос')
		chunks.push(chunk)
	}
	const text = Buffer.concat(chunks).toString('utf8')
	if (text.trim() === '') throw new HttpError(400, 'Пустое тело запроса')
	try {
		return JSON.parse(text)
	} catch {
		throw new HttpError(400, 'Тело запроса — не JSON')
	}
}

/**
 * Клиент может сузить набор инструментов заголовками — для коннекторов, где нельзя задать переменные окружения:
 *   X-Mison-Readonly: true            — без инструментов записи
 *   X-Mison-Groups: reports,receipts  — только эти группы (core всегда)
 * Расширить возможности сверх настроек сервера нельзя: берётся пересечение.
 */
function narrow(config, headers) {
	let groups = config.groups
	let readonly = config.readonly

	const requestedGroups = headers['x-mison-groups']
	if (requestedGroups) {
		const requested = String(requestedGroups).split(',').map((item) => item.trim()).filter(Boolean)
		const unknown = requested.filter((item) => !GROUPS.includes(item))
		if (unknown.length > 0) {
			throw new HttpError(400, `X-Mison-Groups: неизвестные группы ${unknown.join(', ')}. Доступны: ${GROUPS.join(', ')}`)
		}
		groups = groups.filter((group) => requested.includes(group))
	}
	if (/^(1|true|yes)$/i.test(String(headers['x-mison-readonly'] || ''))) readonly = true

	return { groups, readonly }
}

export function createHttpServer({ config = loadConfig(), fetchImpl = globalThis.fetch } = {}) {
	const tokenCache = new TokenCache()
	const keyLimiter = new RateLimiter(config.rateLimit)
	const failLimiter = new RateLimiter(config.authFailLimit)

	const clientIp = (req) => {
		if (config.trustProxy) {
			const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
			if (forwarded) return forwarded
		}
		return req.socket.remoteAddress || 'unknown'
	}

	const log = (entry) => {
		if (config.log) console.error(JSON.stringify({ ts: new Date().toISOString(), ...entry }))
	}

	const cors = (req, res) => {
		const origin = req.headers.origin
		if (origin && config.allowedOrigins.includes(origin)) {
			res.setHeader('Access-Control-Allow-Origin', origin)
			res.setHeader('Vary', 'Origin')
			res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, X-Mison-Groups, X-Mison-Readonly')
			res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
		}
	}

	async function handleMcp(req, res, started) {
		const apiKey = bearerKey(req)
		const ip = clientIp(req)
		const info = { ip, key: null, rpc: null, tool: null }

		const finish = (status) => log({ status, ms: Date.now() - started, ...info })

		try {
			if (!apiKey) {
				finish(401)
				return sendRpcError(res, 401, 'Нужен заголовок Authorization: Bearer <API-ключ Mison>. Ключ выдаёт заведение: кабинет → Интеграции → API-ключи', {
					'WWW-Authenticate': 'Bearer realm="mison"',
				})
			}

			const hash = keyHash(apiKey)
			info.key = hash.slice(0, 8)

			// Перебор ключей: слишком много неудач с одного адреса — отказ без обращения к Mison
			const blocked = failLimiter.peek(ip)
			if (!blocked.allowed) throw new HttpError(429, 'Слишком много неудачных попыток входа', { 'Retry-After': String(blocked.retryAfter) })

			const limited = keyLimiter.hit(hash)
			if (!limited.allowed) throw new HttpError(429, 'Слишком много запросов для этого ключа, подождите минуту', { 'Retry-After': String(limited.retryAfter) })

			const body = await readJson(req, config.maxBodyBytes)
			const messages = Array.isArray(body) ? body : [body]
			info.rpc = messages.map((message) => message?.method).filter(Boolean).join(',') || null
			const call = messages.find((message) => message?.method === 'tools/call')
			info.tool = call?.params?.name ?? null

			const { groups, readonly } = narrow(config, req.headers)
			const client = new MisonClient({ apiKey, baseUrl: config.baseUrl, tokenCache, fetchImpl })

			// Ключ проверяем на подключении, чтобы интерфейс клиента сразу показал «неверный ключ»,
			// а не ошибку при первом вызове инструмента
			if (messages.some((message) => message?.method === 'initialize')) {
				try {
					await client.authenticate()
				} catch (error) {
					if (error instanceof MisonError && error.status === 401) {
						failLimiter.hit(ip)
						throw new HttpError(401, 'Mison не принял API-ключ: он неверный, отозван или просрочен. Проверьте ключ в кабинете: Интеграции → API-ключи', {
							'WWW-Authenticate': 'Bearer realm="mison", error="invalid_token"',
						})
					}
					throw new HttpError(502, 'Не удалось проверить ключ: Mison не отвечает. Повторите позже')
				}
			}

			const { server } = createMisonServer({ client, groups, readonly })
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
			res.on('close', () => {
				transport.close().catch(() => {})
				server.close().catch(() => {})
			})
			await server.connect(transport)
			await transport.handleRequest(req, res, body)
			finish(res.statusCode)
		} catch (error) {
			if (error instanceof HttpError) {
				finish(error.status)
				return sendRpcError(res, error.status, error.message, error.headers)
			}
			finish(500)
			console.error('mison-mcp-http:', error?.stack || error)
			return sendRpcError(res, 500, 'Внутренняя ошибка сервера')
		}
	}

	const server = http.createServer(async (req, res) => {
		const started = Date.now()
		const { pathname } = new URL(req.url || '/', 'http://localhost')
		cors(req, res)

		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			return res.end()
		}

		if (pathname === '/health' && req.method === 'GET') {
			return sendJson(res, 200, { ok: true, version: VERSION, uptime: Math.round(process.uptime()), tokens_cached: tokenCache.size })
		}

		if (pathname !== MCP_PATH) {
			return sendJson(res, 404, { error: 'Не найдено. MCP-сервер отвечает на POST ' + MCP_PATH })
		}

		// Без сессий потоковый канал (GET) и закрытие сессии (DELETE) не нужны
		if (req.method !== 'POST') {
			return sendRpcError(res, 405, 'Метод не поддерживается: сервер работает без сессий, используйте POST', { Allow: 'POST, OPTIONS' })
		}

		return handleMcp(req, res, started)
	})

	server.on('close', () => {
		keyLimiter.stop()
		failLimiter.stop()
	})
	// Отчёты считаются до минуты — держим соединение дольше
	server.requestTimeout = 120_000
	server.headersTimeout = 30_000

	return server
}

function main() {
	const config = loadConfig()
	const server = createHttpServer({ config })

	server.listen(config.port, config.host, () => {
		console.error(`mison-mcp-http ${VERSION}: слушает ${config.host}:${config.port}${config.readonly ? ', только чтение' : ''}, API ${config.baseUrl}`)
	})

	const stop = () => {
		server.close(() => process.exit(0))
		// Зависшие соединения не держат остановку дольше 10 секунд
		setTimeout(() => process.exit(0), 10_000).unref()
	}
	process.on('SIGTERM', stop)
	process.on('SIGINT', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main()
	} catch (error) {
		console.error('mison-mcp-http:', error.message)
		process.exit(1)
	}
}
