#!/usr/bin/env node
// MCP-сервер Mison, локальный запуск (stdio). Ключ и настройки — из переменных окружения.
// Удалённый запуск по HTTP — src/http.js.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { MisonClient, DEFAULT_BASE_URL } from './client.js'
import { parseGroups } from './tools/index.js'
import { createMisonServer, VERSION } from './server.js'

function main() {
	const apiKey = process.env.MISON_API_KEY
	if (!apiKey) {
		console.error('Не задан MISON_API_KEY. Ключ выдаёт заведение: кабинет → Интеграции → API-ключи.')
		process.exit(1)
	}

	const readonly = /^(1|true|yes)$/i.test(process.env.MISON_MCP_READONLY || '')
	const groups = parseGroups(process.env.MISON_MCP_GROUPS)

	const client = new MisonClient({
		apiKey,
		baseUrl: process.env.MISON_API_URL || DEFAULT_BASE_URL,
	})

	const { server, tools } = createMisonServer({ client, groups, readonly })

	// stdout занят протоколом — логируем только в stderr
	console.error(`mison-mcp ${VERSION}: ${tools.length} инструментов${readonly ? ', только чтение' : ''}`)

	return server.connect(new StdioServerTransport())
}

try {
	await main()
} catch (error) {
	console.error('mison-mcp: ', error.message)
	process.exit(1)
}
