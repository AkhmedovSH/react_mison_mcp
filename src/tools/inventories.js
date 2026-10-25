// Инвентаризация: остатки, расчёт без записи, создание (черновик по умолчанию).

import { z } from 'zod'
import { getTool, postReadTool, writeTool, pointIdRequired, newExternalId } from './define.js'

const g = 'inventories'

const fmt = (value) => new Intl.NumberFormat('ru-RU').format(value)

const items = z
	.array(
		z.object({
			product_id: z.number().int().positive().describe('Товар из mison_receipt_products или mison_inventory_balances'),
			actual_quantity: z.number().min(0).describe('Посчитано на складе в единице товара; 0 — на складе ничего нет'),
		}),
	)
	.min(1)
	.max(500)
	.describe('Что посчитано. Позиции, которых нет в списке, не затрагиваются; один товар — одна строка')

export const inventoryTools = [
	getTool({
		name: 'mison_inventory_balances',
		group: g,
		title: 'Остатки склада для подсчёта',
		description:
			'Что система считает лежащим на складе сейчас: товар, остаток, себестоимость. Берите, чтобы вести подсчёт или показать «по системе должно быть». ' +
			'Ищите по части названия; only_with_balance=true — только то, что числится на складе. Склад — из mison_receipt_warehouses.',
		path: '/inventories/balances',
		input: {
			point_id: pointIdRequired,
			warehouse_id: z.number().int().positive().describe('Склад точки из mison_receipt_warehouses'),
			search: z.string().optional().describe('Часть названия'),
			only_with_balance: z.boolean().optional(),
			limit: z.number().int().positive().max(200).optional(),
		},
	}),
	postReadTool({
		name: 'mison_inventory_preview',
		group: g,
		title: 'Рассчитать инвентаризацию',
		description:
			'Расчёт БЕЗ записи: по посчитанным количествам сервер сам берёт остаток и себестоимость и возвращает расхождение по каждому товару, суммы недостачи и излишка и токен check. ' +
			'Недостача при проведении списывается по себестоимости и попадает в прибыли и убытки — поэтому ВСЕГДА вызывайте расчёт и показывайте человеку суммы до создания инвентаризации. ' +
			'Если в drift_product_ids есть товары, сразу проводить нельзя — только черновик.',
		path: '/inventories/preview',
		input: {
			point_id: pointIdRequired,
			warehouse_id: z.number().int().positive().describe('Склад точки'),
			items,
		},
	}),
	writeTool({
		name: 'mison_create_inventory',
		group: g,
		title: 'Создать инвентаризацию',
		description:
			'Создаёт инвентаризацию склада. ПО УМОЛЧАНИЮ — ЧЕРНОВИК: остатки не двигаются, человек проверит и проведёт её в кабинете. ' +
			'Провести сразу (is_draft=false) можно только после mison_inventory_preview и явного согласия человека, с токеном check из расчёта: недостача спишется по себестоимости и попадёт в P&L. ' +
			'Если с момента расчёта остаток изменился (товар продавали), сервер ответит 409 и ничего не запишет — покажите человеку новые цифры из ответа и спросите снова. Откатить проведённую можно только удалением в кабинете. ' +
			'Повтор с тем же external_id не создаёт второй документ.',
		destructive: true,
		idempotent: true,
		input: {
			point_id: pointIdRequired,
			warehouse_id: z.number().int().positive().describe('Склад точки'),
			items,
			is_draft: z.boolean().optional().describe('true (по умолчанию) — черновик; false — провести сразу, нужен check'),
			check: z.string().optional().describe('Токен из mison_inventory_preview; обязателен при is_draft=false'),
			note: z.string().max(500).optional(),
			external_id: z.string().max(100).optional().describe('Не передавайте — вернёте тот, что дал первый вызов'),
		},
		validate: (args) => {
			if (args.is_draft === false && !args.check) {
				throw new Error('Для проведения сразу (is_draft=false) нужен check из mison_inventory_preview. Сначала вызовите расчёт или создайте черновик.')
			}
		},
		summary: (args) => {
			args.external_id = args.external_id || newExternalId()
			const draft = args.is_draft !== false
			const lines = args.items.map((item) => `  • товар ${item.product_id}: посчитано ${fmt(item.actual_quantity)}`)
			return [
				`Склад ${args.warehouse_id} точки ${args.point_id}, позиций ${args.items.length}.`,
				...lines,
				draft
					? 'Это ЧЕРНОВИК: остатки не изменятся, проводит человек в кабинете.'
					: 'Инвентаризация будет ПРОВЕДЕНА СРАЗУ: остатки выровняются по посчитанному, недостача спишется по себестоимости и попадёт в прибыли и убытки.',
				args.note ? `Примечание: ${args.note}` : null,
				`При повторном вызове передайте external_id=${args.external_id}${args.check ? ' и тот же check' : ''}.`,
			]
				.filter(Boolean)
				.join('\n')
		},
		run: (args, client) => {
			const body = { ...args, is_draft: args.is_draft !== false, external_id: args.external_id || newExternalId() }
			return client.request('POST', '/inventories', { body, idempotent: true })
		},
	}),
	getTool({
		name: 'mison_get_inventory',
		group: g,
		title: 'Принятая инвентаризация',
		description: 'Инвентаризация по external_id: статус (draft — ждёт проведения в кабинете, posted — проведена, deleted — удалена), итоги недостачи и излишка и строки.',
		path: '/inventories',
		input: { external_id: z.string().describe('Тот external_id, с которым создавали инвентаризацию') },
	}),
]
