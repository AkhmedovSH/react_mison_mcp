// Заказы: расчёт корзины, создание, статус, отмена.

import { z } from 'zod'
import { getTool, postReadTool, writeTool, pointIdRequired, newExternalId } from './define.js'

const g = 'orders'
const fmt = (value) => new Intl.NumberFormat('ru-RU').format(value)

const modifier = z.object({
	product_id: z.number().int().positive().describe('Компонент из modifier_groups блюда'),
	quantity: z.number().positive().optional().describe('Штук; цену, бесплатный лимит группы и «входит в цену» считает сервер'),
})

const item = z.object({
	product_id: z.number().int().positive().describe('Товар из меню'),
	quantity: z.number().positive().describe('Количество, дробное допустимо'),
	comment: z.string().max(255).optional().describe('Пожелание по позиции, уйдёт на кухню'),
	modifiers: z.array(modifier).optional(),
})

const address = z.object({
	street: z.string().optional().describe('Улица и дом'),
	apartment: z.string().optional(),
	floor: z.string().optional(),
	entrance: z.string().optional(),
	intercom: z.string().optional(),
	latitude: z.number().optional(),
	longitude: z.number().optional(),
})

export const orderTools = [
	postReadTool({
		name: 'mison_order_calculate',
		group: g,
		title: 'Рассчитать корзину',
		description:
			'Считает итог заказа БЕЗ создания: цены, модификаторы, стоимость доставки (для order_type_id=3 нужны координаты адреса), недоступные позиции из стоп-листа. Вызывайте перед созданием заказа и показывайте сумму человеку.',
		path: '/orders/calculate',
		input: {
			point_id: pointIdRequired,
			order_type_id: z.number().int().optional().describe('1 зал, 2 с собой, 3 доставка'),
			address: address.optional().describe('Для доставки — хотя бы координаты'),
			items: z.array(item).min(1),
		},
	}),
	writeTool({
		name: 'mison_order_create',
		group: g,
		title: 'Создать заказ',
		description:
			'Создаёт заказ на точке (зал, с собой, доставка) — он попадёт на кассу и на кухню. Цены считает сервер по ценам заведения. ' +
			'Сначала mison_order_calculate, покажите человеку состав и сумму, дождитесь «да». Тип оплаты — из mison_reference (payment_types). Для доставки обязателен адрес. ' +
			'Отменить можно только пока заказ не принят кассой.',
		idempotent: true,
		input: {
			point_id: pointIdRequired,
			order_type_id: z.number().int().describe('1 зал, 2 с собой, 3 доставка'),
			payment_type_id: z.number().int().describe('Тип оплаты точки из mison_reference'),
			client: z.object({ phone: z.string().describe('Телефон гостя'), name: z.string().optional() }),
			items: z.array(item).min(1),
			address: address.optional().describe('Обязателен для доставки'),
			comment: z.string().max(500).optional(),
			persons: z.number().int().positive().optional(),
			table_id: z.number().int().optional().describe('Стол, для заказа в зале'),
			scheduled_at: z.string().optional().describe('Предзаказ, ISO-8601 с часовым поясом'),
			external_id: z.string().max(100).optional().describe('Не передавайте — вернёте тот, что дал первый вызов'),
		},
		summary: (args) => {
			args.external_id = args.external_id || newExternalId()
			const lines = args.items.map((line) => `  • товар ${line.product_id} × ${fmt(line.quantity)}${line.comment ? ` (${line.comment})` : ''}`)
			return [
				`Точка ${args.point_id}, тип заказа ${args.order_type_id}, оплата ${args.payment_type_id}.`,
				`Гость: ${args.client.name || ''} ${args.client.phone}.`,
				args.address?.street ? `Адрес: ${args.address.street}.` : null,
				...lines,
				args.comment ? `Комментарий: ${args.comment}` : null,
				'Заказ уйдёт на кассу и на кухню.',
				`При повторном вызове передайте external_id=${args.external_id}.`,
			]
				.filter(Boolean)
				.join('\n')
		},
		run: (args, client) => client.request('POST', '/orders', { body: { ...args, external_id: args.external_id || newExternalId() }, idempotent: true }),
	}),
	getTool({
		name: 'mison_order_status',
		group: g,
		title: 'Статус заказа',
		description: 'Заказ по его order_id: статус, состав, сумма, доставка.',
		path: '/orders/{order_id}',
		pathParams: ['order_id'],
		input: { order_id: z.number().int().positive() },
	}),
	writeTool({
		name: 'mison_order_cancel',
		group: g,
		title: 'Отменить заказ',
		description:
			'Отменяет заказ, пока касса его не приняла (после этого — только на кассе, придёт 409). Причину берите из mison_reference (cancel_causes), без неё отмена не попадёт в отчёт по причинам. Спросите человека, прежде чем отменять.',
		destructive: true,
		idempotent: true,
		input: {
			order_id: z.number().int().positive(),
			cancel_cause_id: z.number().int().optional().describe('Причина из cancel_causes'),
			comment: z.string().max(255).optional(),
		},
		summary: (args) => `Отмена заказа ${args.order_id}${args.comment ? `, комментарий: ${args.comment}` : ''}. Если касса уже приняла заказ, отмена не пройдёт.`,
		run: (args, client) => {
			const { order_id, ...body } = args
			return client.request('POST', `/orders/${order_id}/cancel`, { body, idempotent: true })
		},
	}),
]
