// Реестр инструментов и их подключение к MCP-серверу.

import { z } from 'zod'
import { GROUPS, CONFIRM_FIELD, confirmationText } from './define.js'
import { coreTools, reportTools } from './reports.js'
import { receiptTools } from './receipts.js'
import { inventoryTools } from './inventories.js'
import { transferTools } from './transfers.js'
import { menuTools } from './menu.js'
import { orderTools } from './orders.js'
import { reservationTools } from './reservations.js'
import { attendanceTools } from './attendance.js'
import { ok, fail, text } from '../result.js'

export const ALL_TOOLS = [
	...coreTools,
	...reportTools,
	...receiptTools,
	...inventoryTools,
	...transferTools,
	...menuTools,
	...orderTools,
	...reservationTools,
	...attendanceTools,
]

/**
 * Отбор по настройкам: группы (MISON_MCP_GROUPS) и режим «только чтение» (MISON_MCP_READONLY).
 * core включён всегда — без списка точек остальные инструменты бесполезны.
 */
export function selectTools({ groups = GROUPS, readonly = false } = {}) {
	const enabled = new Set([...groups, 'core'])
	// Инструмент может принадлежать нескольким группам: склады и товары нужны и приходу, и инвентаризации
	return ALL_TOOLS.filter((tool) => [].concat(tool.group).some((group) => enabled.has(group)) && !(readonly && tool.write))
}

export function parseGroups(value) {
	if (!value) return GROUPS
	const requested = value.split(',').map((item) => item.trim()).filter(Boolean)
	const unknown = requested.filter((item) => !GROUPS.includes(item))
	if (unknown.length > 0) {
		throw new Error(`MISON_MCP_GROUPS: неизвестные группы ${unknown.join(', ')}. Доступны: ${GROUPS.join(', ')}`)
	}
	return requested
}

export function registerTools(server, client, options = {}) {
	const tools = selectTools(options)

	for (const tool of tools) {
		const shape = tool.write ? { ...tool.input, confirmed: CONFIRM_FIELD } : tool.input

		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: shape,
				annotations: tool.write
					? { title: tool.title, readOnlyHint: false, destructiveHint: tool.destructive, idempotentHint: tool.idempotent, openWorldHint: false }
					: { title: tool.title, readOnlyHint: true, openWorldHint: false },
			},
			async (args) => {
				try {
					const { confirmed, ...params } = args
					// Очевидно неверный запрос отклоняем до показа итога человеку и до отправки
					if (tool.write && tool.validate) tool.validate(params)
					if (tool.write && confirmed !== true) {
						return text(confirmationText(tool, params))
					}
					return ok(await tool.run(params, client))
				} catch (error) {
					return fail(error)
				}
			},
		)
	}

	return tools
}

export { z }
