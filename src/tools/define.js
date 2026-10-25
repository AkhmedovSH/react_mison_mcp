// Описание инструментов: общие параметры и заготовки для чтения и записи.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const GROUPS = ['core', 'reports', 'receipts', 'inventories', 'transfers', 'menu', 'orders', 'reservations', 'attendance']

// --- общие параметры ---------------------------------------------------------

export const pointId = z
	.string()
	.optional()
	.describe('UUID точки из mison_points, можно несколько через запятую. Без параметра — все точки бренда')

export const pointIdRequired = z.string().describe('UUID точки из mison_points')

export const date = (label) =>
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат YYYY-MM-DD')
		.describe(label)

export const dateFrom = date('Начало периода, YYYY-MM-DD, включительно')
export const dateTo = date('Конец периода, YYYY-MM-DD, включительно')

export const positiveInt = (label) => z.number().int().positive().describe(label)

export const newExternalId = () => `mcp-${randomUUID()}`

// --- заготовки ---------------------------------------------------------------

/** Чтение: GET без побочных эффектов, параметры уходят в query как есть */
export function getTool({ name, group, title, description, path, input = {}, pathParams = [] }) {
	return {
		name,
		group,
		title,
		description,
		input,
		write: false,
		run: (args, client) => {
			const query = { ...args }
			let resolved = path
			for (const key of pathParams) {
				resolved = resolved.replace(`{${key}}`, encodeURIComponent(String(query[key])))
				delete query[key]
			}
			return client.get(resolved, query)
		},
	}
}

/** Запрос на чтение, который по протоколу POST, но ничего не меняет (расчёт, OLAP) */
export function postReadTool({ name, group, title, description, path, input = {} }) {
	return {
		name,
		group,
		title,
		description,
		input,
		write: false,
		run: (args, client) => client.request('POST', path, { body: args, idempotent: true }),
	}
}

/**
 * Запись. Без confirmed=true ничего не отправляется: инструмент возвращает итог для показа
 * человеку. ИИ-ассистент не должен проводить документы и менять данные по своей догадке.
 *
 * idempotent — у запроса есть external_id/event_id: при обрыве сети его безопасно повторить.
 * summary(args) — текст итога для человека; без него показывается тело запроса.
 */
export function writeTool({ name, group, title, description, input = {}, run, summary, validate, destructive = false, idempotent = false }) {
	return { name, group, title, description, input, write: true, run, summary, validate, destructive, idempotent }
}

export const CONFIRM_FIELD = z
	.boolean()
	.optional()
	.describe(
		'true — только после того, как человек увидел итог и явно ответил «да». Без него инструмент ничего не отправит, а вернёт итог для подтверждения',
	)

export function confirmationText(tool, args) {
	const body = tool.summary ? tool.summary(args) : JSON.stringify(args, null, 2)
	return [
		`НЕ ОТПРАВЛЕНО: нужно подтверждение человека. Действие: ${tool.title}.`,
		'',
		body,
		'',
		'Покажите это пользователю простым языком и спросите «отправлять?».',
		'Только после явного «да» вызовите инструмент ещё раз с теми же параметрами и confirmed=true.',
	].join('\n')
}
