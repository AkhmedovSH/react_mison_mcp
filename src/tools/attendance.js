// Приход и уход сотрудников: отметки в учёт рабочего времени и зарплату.

import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getTool, writeTool, pointId, dateFrom, dateTo } from './define.js'

const g = 'attendance'

export const attendanceTools = [
	getTool({
		name: 'mison_attendance_employees',
		group: g,
		title: 'Сотрудники для отметок',
		description: 'Действующие сотрудники, которых можно отметить: employee_id и открытая смена (open_shift — сейчас на смене или забыл отметить уход).',
		path: '/attendance/employees',
		input: { point_id: pointId, search: z.string().optional().describe('Часть имени') },
	}),
	getTool({
		name: 'mison_attendance_shifts',
		group: g,
		title: 'Смены сотрудников',
		description: 'Смены сотрудников по приходу и уходу за период — для сверки отправленных отметок. Период до 62 дней.',
		path: '/attendance/shifts',
		input: { date_from: dateFrom, date_to: dateTo, point_id: pointId },
	}),
	writeTool({
		name: 'mison_attendance_mark',
		group: g,
		title: 'Отметить приход или уход',
		description:
			'Отмечает приход (check_in) или уход (check_out) сотрудников. Отметки попадают в «Посещаемость» и ВЛИЯЮТ НА ЗАРПЛАТУ по часам. ' +
			'time — когда это произошло на самом деле (ISO-8601 с поясом или «YYYY-MM-DD HH:MM» по времени заведения), не в будущем и не старше 62 дней. Повтор события с тем же event_id дубля не создаст. ' +
			'Покажите человеку, кого и когда отмечаете, и дождитесь «да».',
		idempotent: true,
		input: {
			events: z
				.array(
					z.object({
						employee_id: z.number().int().positive().describe('Сотрудник из mison_attendance_employees'),
						type: z.enum(['check_in', 'check_out']).describe('check_in — пришёл, check_out — ушёл'),
						time: z.string().describe('Когда произошло: 2026-10-19T08:58:12+05:00'),
						point_id: z.string().optional().describe('Точка отметки; без неё — точка сотрудника'),
						event_id: z.string().max(100).optional().describe('Не передавайте — вернёте тот, что дал первый вызов'),
					}),
				)
				.min(1)
				.max(500),
		},
		summary: (args) => {
			for (const event of args.events) event.event_id = event.event_id || `mcp-${randomUUID()}`
			const lines = args.events.map((event) => `  • сотрудник ${event.employee_id}: ${event.type === 'check_in' ? 'пришёл' : 'ушёл'} в ${event.time} (event_id=${event.event_id})`)
			return [...lines, 'Отметки изменят «Посещаемость» и зарплату по часам.', 'При повторном вызове передайте те же event_id.'].join('\n')
		},
		run: (args, client) => {
			const events = args.events.map((event) => ({ ...event, event_id: event.event_id || `mcp-${randomUUID()}` }))
			return client.request('POST', '/attendance/events', { body: { events }, idempotent: true })
		},
	}),
]
