// HTTP-клиент партнёрского API Mison: обмен ключа на токен, повтор при 401 и 429.

import { createHash } from 'node:crypto'

export const DEFAULT_BASE_URL = 'https://backend.mison.uz/api/integrations/v1'

export class MisonError extends Error {
	constructor(message, { status = 0, body = null } = {}) {
		super(message)
		this.name = 'MisonError'
		this.status = status
		this.body = body
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Ключи без значения в запрос не попадают; массивы — через запятую, как ждёт API
function buildQuery(query = {}) {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') continue
		if (Array.isArray(value)) {
			if (value.length > 0) params.set(key, value.join(','))
		} else {
			params.set(key, String(value))
		}
	}
	const text = params.toString()
	return text ? `?${text}` : ''
}

/** Отпечаток ключа для кэша и журнала: сам ключ нигде не хранится и не печатается */
export function keyHash(apiKey) {
	return createHash('sha256').update(String(apiKey)).digest('hex')
}

/**
 * Общий кэш токенов для HTTP-режима: там на каждый запрос создаётся свой клиент, а обмен ключа на токен
 * ограничен 60 запросами в минуту. Ключ кэша — отпечаток ключа. Параллельные запросы одного ключа
 * ждут один обмен (single-flight), а не бьют по эндпоинту пачкой.
 */
export class TokenCache {
	#entries = new Map()
	#inflight = new Map()
	#max

	constructor({ max = 5000 } = {}) {
		this.#max = max
	}

	get size() {
		return this.#entries.size
	}

	async resolve(hash, exchange, force = false) {
		const hit = this.#entries.get(hash)
		if (!force && hit && Date.now() < hit.expiresAt) return hit.token

		let pending = this.#inflight.get(hash)
		if (!pending) {
			pending = exchange()
				.then((entry) => {
					// Самая старая запись уходит, когда ключей слишком много
					if (this.#entries.size >= this.#max) this.#entries.delete(this.#entries.keys().next().value)
					this.#entries.set(hash, entry)
					return entry.token
				})
				.finally(() => this.#inflight.delete(hash))
			this.#inflight.set(hash, pending)
		}
		return pending
	}

	/** Забыть ключ, который Mison отклонил: иначе в кэше жил бы токен отозванного ключа */
	forget(hash) {
		this.#entries.delete(hash)
	}
}

export class MisonClient {
	#apiKey
	#baseUrl
	#timeoutMs
	#fetch
	#tokenCache
	#keyHash
	#token = null
	#tokenExpiresAt = 0

	constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, timeoutMs = 65000, fetchImpl = globalThis.fetch, tokenCache = null } = {}) {
		if (!apiKey) throw new Error('Не задан MISON_API_KEY — ключ из кабинета: Интеграции → API-ключи')
		this.#apiKey = apiKey
		this.#baseUrl = baseUrl.replace(/\/+$/, '')
		this.#timeoutMs = timeoutMs
		this.#fetch = fetchImpl
		this.#tokenCache = tokenCache
		this.#keyHash = keyHash(apiKey)
	}

	get keyHash() {
		return this.#keyHash
	}

	/** Обмен ключа на токен; срок берём с запасом, а не ждём 401 */
	async #exchange() {
		const response = await this.#send('POST', '/auth/token', { body: { api_key: this.#apiKey }, auth: false })
		if (!response.body?.access_token) {
			throw new MisonError('Mison не вернул access_token', { status: response.status, body: response.body })
		}
		const lifetime = Number(response.body.expires_in) > 0 ? Number(response.body.expires_in) : 86400
		return { token: response.body.access_token, expiresAt: Date.now() + Math.max(60, lifetime - 3600) * 1000 }
	}

	// Токен живёт 30 дней и один на ключ
	async #getToken(force = false) {
		if (this.#tokenCache) {
			try {
				return await this.#tokenCache.resolve(this.#keyHash, () => this.#exchange(), force)
			} catch (error) {
				if (error instanceof MisonError && error.status === 401) this.#tokenCache.forget(this.#keyHash)
				throw error
			}
		}

		if (!force && this.#token && Date.now() < this.#tokenExpiresAt) return this.#token

		const entry = await this.#exchange()
		this.#token = entry.token
		this.#tokenExpiresAt = entry.expiresAt
		return this.#token
	}

	/** Проверка ключа: бросает MisonError(401), если Mison его не принимает */
	async authenticate() {
		await this.#getToken()
	}

	async #send(method, path, { query, body, auth = true, token } = {}) {
		const headers = { Accept: 'application/json' }
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		if (auth) headers.Authorization = `Bearer ${token}`

		let response
		try {
			response = await this.#fetch(this.#baseUrl + path + buildQuery(query), {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(this.#timeoutMs),
			})
		} catch (error) {
			const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
			throw new MisonError(
				timedOut
					? 'Mison не ответил вовремя. Отчёт слишком тяжёлый — сократите период или число точек'
					: `Не удалось связаться с Mison: ${error?.cause?.code || error?.message}`,
				{ status: 0 },
			)
		}

		const text = await response.text()
		let parsed = null
		try {
			parsed = text ? JSON.parse(text) : null
		} catch {
			parsed = null
		}

		if (!response.ok) {
			const message = parsed?.message || `Mison вернул ${response.status}`
			throw new MisonError(message, { status: response.status, body: parsed })
		}
		return { status: response.status, body: parsed }
	}

	/**
	 * Запрос с авторизацией. idempotent — запрос можно безопасно повторить (чтение, запись с
	 * external_id): при обрыве сети и 5xx он повторяется один раз.
	 */
	async request(method, path, { query, body, idempotent = method === 'GET' } = {}) {
		let refreshed = false
		let retriedNetwork = false
		let retriedLimit = false

		for (;;) {
			const token = await this.#getToken()
			try {
				return (await this.#send(method, path, { query, body, token })).body
			} catch (error) {
				if (!(error instanceof MisonError)) throw error

				// Токен отозван или истёк: один раз берём новый и повторяем
				if (error.status === 401 && !refreshed) {
					refreshed = true
					await this.#getToken(true)
					continue
				}
				// Лимит запросов: ждём, сколько просит сервер (не дольше 20 с), и повторяем один раз
				if (error.status === 429 && !retriedLimit) {
					retriedLimit = true
					const wait = Math.min(20, Math.max(1, Number(error.body?.retry_after) || 5))
					await sleep(wait * 1000)
					continue
				}
				// Обрыв сети или сбой сервера
				if (idempotent && !retriedNetwork && (error.status === 0 || error.status >= 500)) {
					retriedNetwork = true
					await sleep(500)
					continue
				}
				throw error
			}
		}
	}

	get(path, query, options = {}) {
		return this.request('GET', path, { query, ...options })
	}

	post(path, body, options = {}) {
		return this.request('POST', path, { body, idempotent: false, ...options })
	}

	patch(path, body, options = {}) {
		return this.request('PATCH', path, { body, idempotent: false, ...options })
	}
}
