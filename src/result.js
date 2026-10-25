// Ответы инструментов: компактный JSON с потолком по размеру и понятные ошибки.

import { MisonError } from './client.js'

export const MAX_CHARS = Number(process.env.MISON_MCP_MAX_CHARS) > 0 ? Number(process.env.MISON_MCP_MAX_CHARS) : 60000

function text(value, isError = false) {
	const result = { content: [{ type: 'text', text: value }] }
	if (isError) result.isError = true
	return result
}

// Самый длинный массив верхнего уровня — то, что раздувает ответ (rows, items, employees…)
function largestArrayKey(data) {
	let best = null
	for (const [key, value] of Object.entries(data)) {
		if (Array.isArray(value) && value.length > 1 && (best === null || value.length > data[best].length)) {
			best = key
		}
	}
	return best
}

/**
 * Данные → текст. Слишком длинный ответ модель всё равно не прочитает, а контекст съест:
 * режем самый длинный массив и честно пишем, сколько строк показано из скольких.
 */
export function ok(data, max = MAX_CHARS) {
	let json = JSON.stringify(data)
	if (json === undefined) return text('Пустой ответ')
	if (json.length <= max || data === null || typeof data !== 'object' || Array.isArray(data)) {
		return text(json.length <= max ? json : json.slice(0, max) + '…[ответ обрезан]')
	}

	const copy = { ...data }
	const key = largestArrayKey(copy)
	if (key === null) return text(json.slice(0, max) + '…[ответ обрезан]')

	const total = copy[key].length
	let shown = total
	while (shown > 1) {
		shown = Math.floor(shown / 2)
		copy[key] = data[key].slice(0, shown)
		copy._mcp_truncated = {
			field: key,
			shown,
			total,
			hint: 'Ответ не поместился. Сузьте период, точку или фильтр, либо запросите итог группировкой',
		}
		json = JSON.stringify(copy)
		if (json.length <= max) break
	}
	return text(json)
}

const HINTS = {
	401: 'Ключ недействителен: проверьте MISON_API_KEY (его могли удалить или перевыпустить в кабинете).',
	403: 'У ключа нет этого права. Включить его может владелец: кабинет → Интеграции → API-ключи → Редактировать.',
	404: 'Не найдено: проверьте идентификатор (id, point_id) — берите их из справочных инструментов.',
	409: 'Конфликт состояния. Прочитайте сообщение и не повторяйте тот же запрос вслепую.',
	429: 'Слишком много запросов. Подождите минуту.',
}

export function fail(error) {
	if (error instanceof MisonError) {
		const hint = HINTS[error.status]
		const details = error.body && typeof error.body === 'object'
			? { ...error.body, message: undefined }
			: null
		const extra = details && Object.values(details).some((value) => value !== undefined)
			? '\n' + JSON.stringify(details)
			: ''
		return text(`Ошибка Mison${error.status ? ` (${error.status})` : ''}: ${error.message}${hint ? `\n${hint}` : ''}${extra}`, true)
	}
	return text(`Ошибка: ${error?.message || String(error)}`, true)
}

export { text }
