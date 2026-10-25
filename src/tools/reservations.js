// Бронь столов: залы, свободное время, брони.

import { z } from 'zod'
import { getTool, writeTool, pointIdRequired, pointId, newExternalId } from './define.js'

const g = 'reservations'

const time = z.string().regex(/^\d{2}:\d{2}$/, 'Формат HH:MM')
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат YYYY-MM-DD')

const deposit = z.object({
	amount: z.number().positive().describe('Сумма депозита, которую вы приняли у гостя'),
	payment_type_id: z.number().int().describe('Тип оплаты депозита'),
})

export const reservationTools = [
	getTool({
		name: 'mison_reservation_settings',
		group: g,
		title: 'Правила бронирования точки',
		description: 'Правила точки: длительность брони по умолчанию, лимит автоподтверждения, часы работы. Читайте перед созданием брони.',
		path: '/reservations/settings',
		input: { point_id: pointIdRequired },
	}),
	getTool({
		name: 'mison_reservation_halls',
		group: g,
		title: 'Залы и столы',
		description: 'Залы точки и столы в них: table_id, вместимость. table_id нужен для брони на стол.',
		path: '/reservations/halls',
		input: { point_id: pointIdRequired },
	}),
	getTool({
		name: 'mison_reservation_availability',
		group: g,
		title: 'Свободные столы и время',
		description:
			'Свободные столы на дату и число гостей. С time — какие столы свободны на этот интервал, без него — сетка слотов на день. Вызывайте перед бронью, не обещайте гостю время наугад.',
		path: '/reservations/availability',
		input: {
			point_id: pointIdRequired,
			date: dateOnly.describe('Дата брони YYYY-MM-DD'),
			guests: z.number().int().positive(),
			time: time.optional().describe('Время начала HH:MM, местное время точки'),
			duration_minutes: z.number().int().positive().optional(),
		},
	}),
	getTool({
		name: 'mison_reservations',
		group: g,
		title: 'Список броней',
		description:
			'Брони точки за период с фильтром по статусу (pending — заявка, created — подтверждена, seated — посажены, cancelled, no_show). changed_since + after_id + limit — лента изменений для сверки.',
		path: '/reservations',
		input: {
			point_id: pointId,
			date_from: dateOnly.optional(),
			date_to: dateOnly.optional(),
			status: z.string().optional().describe('Через запятую: pending, created, seated, cancelled, no_show'),
			changed_since: z.string().optional().describe('ISO-время: брони, изменённые после него'),
			after_id: z.number().int().optional(),
			limit: z.number().int().positive().max(500).optional(),
		},
	}),
	getTool({
		name: 'mison_reservation',
		group: g,
		title: 'Одна бронь',
		description: 'Бронь по её id (UUID из ответа создания или списка): статус, стол, гость, депозит.',
		path: '/reservations/{id}',
		pathParams: ['id'],
		input: { id: z.string().uuid() },
	}),
	writeTool({
		name: 'mison_reservation_create',
		group: g,
		title: 'Создать бронь',
		description:
			'Ставит бронь на стол или на заведение (без table_id). Сначала mison_reservation_availability, чтобы стол был свободен; покажите гостю дату, время, стол и дождитесь «да». Занятый стол — 409. ' +
			'Повтор с тем же external_id вернёт ту же бронь.',
		idempotent: true,
		input: {
			point_id: pointIdRequired,
			date: dateOnly.describe('Дата YYYY-MM-DD, местное время точки'),
			start_time: time,
			guests: z.number().int().positive(),
			guest: z.object({ phone: z.string().describe('Телефон гостя'), name: z.string().optional() }),
			end_time: time.optional(),
			duration_minutes: z.number().int().positive().optional(),
			table_id: z.number().int().optional().describe('Без него — бронь на заведение'),
			type: z.enum(['table', 'banquet']).optional(),
			comment: z.string().max(255).optional(),
			deposit: deposit.optional(),
			external_id: z.string().max(100).optional().describe('Не передавайте — вернёте тот, что дал первый вызов'),
		},
		summary: (args) => {
			args.external_id = args.external_id || newExternalId()
			return [
				`Точка ${args.point_id}: ${args.date} в ${args.start_time}, гостей ${args.guests}${args.table_id ? `, стол ${args.table_id}` : ', без стола'}.`,
				`Гость: ${args.guest.name || ''} ${args.guest.phone}.`,
				args.deposit ? `Депозит: ${args.deposit.amount}.` : null,
				args.comment ? `Комментарий: ${args.comment}` : null,
				`При повторном вызове передайте external_id=${args.external_id}.`,
			]
				.filter(Boolean)
				.join('\n')
		},
		run: (args, client) => client.request('POST', '/reservations', { body: { ...args, external_id: args.external_id || newExternalId() }, idempotent: true }),
	}),
	writeTool({
		name: 'mison_reservation_update',
		group: g,
		title: 'Перенести или изменить бронь',
		description: 'Меняет бронь, пока она ждёт гостя (pending, created): время, число гостей, стол (table_id=null снимает стол), комментарий. Передавайте только то, что меняется. Занятый стол — 409.',
		idempotent: true,
		input: {
			id: z.string().uuid().describe('UUID брони'),
			date: dateOnly.optional(),
			start_time: time.optional(),
			end_time: time.optional(),
			duration_minutes: z.number().int().positive().optional(),
			guests: z.number().int().positive().optional(),
			table_id: z.number().int().nullable().optional(),
			comment: z.string().max(255).optional(),
		},
		summary: (args) => {
			const { id, ...changes } = args
			return `Бронь ${id}: меняем ${JSON.stringify(changes)}.`
		},
		run: (args, client) => {
			const { id, ...body } = args
			return client.request('PATCH', `/reservations/${id}`, { body, idempotent: true })
		},
	}),
	writeTool({
		name: 'mison_reservation_cancel',
		group: g,
		title: 'Отменить бронь',
		description:
			'Отменяет бронь, пока она ждёт гостя. Если по брони внесён депозит, обязательно deposit_status: retained (оставляем) или refunded (возвращаем). cancelled_by: guest — отменил гость, partner — вы.',
		destructive: true,
		idempotent: true,
		input: {
			id: z.string().uuid().describe('UUID брони'),
			reason: z.string().max(255).optional().describe('Причина, её увидит кассир'),
			cancelled_by: z.enum(['guest', 'partner']).optional(),
			deposit_status: z.enum(['retained', 'refunded']).optional(),
		},
		summary: (args) => `Отмена брони ${args.id}${args.reason ? `, причина: ${args.reason}` : ''}${args.deposit_status ? `, депозит: ${args.deposit_status}` : ''}.`,
		run: (args, client) => {
			const { id, ...body } = args
			return client.request('POST', `/reservations/${id}/cancel`, { body, idempotent: true })
		},
	}),
]
