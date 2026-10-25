// Приход товара: справочники и приходная накладная. Приход проводится сразу.

import { z } from 'zod'
import { getTool, writeTool, pointIdRequired, pointId, newExternalId } from './define.js'

const g = 'receipts'
const stockGroups = ['receipts', 'inventories', 'transfers']

const money = (value) => Math.round(value * 100) / 100
const fmt = (value) => new Intl.NumberFormat('ru-RU').format(value)

export const receiptTools = [
	getTool({
		name: 'mison_receipt_warehouses',
		group: stockGroups,
		title: 'Склады точек',
		description: 'Склады точек: warehouse_id нужен для прихода. Склад принадлежит одной точке — выбирайте тот, что относится к нужной точке.',
		path: '/receipts/warehouses',
		input: { point_id: pointId },
	}),
	getTool({
		name: 'mison_receipt_suppliers',
		group: g,
		title: 'Поставщики',
		description: 'Поставщики бренда: supplier_id нужен для прихода. Ищите по части названия, не угадывайте id.',
		path: '/receipts/suppliers',
		input: { search: z.string().optional().describe('Часть названия поставщика') },
	}),
	getTool({
		name: 'mison_receipt_products',
		group: stockGroups,
		title: 'Товары для прихода',
		description:
			'Товары, которые можно оприходовать на склад (сырьё, товары, заготовки), с единицей измерения. product_id нужен для прихода. Ищите по части названия; если подходит несколько — спросите человека. Количество в приходе — в этой единице.',
		path: '/receipts/products',
		input: {
			search: z.string().optional().describe('Часть названия'),
			limit: z.number().int().positive().max(200).optional(),
		},
	}),
	getTool({
		name: 'mison_get_receipt',
		group: g,
		title: 'Принятый приход',
		description: 'Приходная накладная по external_id, который вы присылали: статус (posted — действует, deleted — удалена в кабинете), сумма и строки.',
		path: '/receipts',
		input: { external_id: z.string().describe('Тот external_id, с которым создавали приход') },
	}),
	writeTool({
		name: 'mison_create_receipt',
		group: g,
		title: 'Создать приходную накладную',
		description:
			'Оформляет приход товара: накладная ПРОВОДИТСЯ СРАЗУ — растёт остаток на складе, пересчитывается себестоимость, увеличивается долг поставщику. Отменить можно только удалением прихода в кабинете. ' +
			'Если человек просит «черновик» или сомневается, передайте is_draft=true: документ ляжет без проводок, остаток и долг не изменятся, провести его можно будет в кабинете. ' +
			'Перед вызовом найдите id склада, поставщика и товаров справочными инструментами, а не угадывайте; покажите человеку итог и дождитесь «да». Цена — за единицу, больше 0. ' +
			'Дата не в будущем и не старше 30 дней. Повтор с тем же external_id не создаёт второй приход.',
		idempotent: true,
		input: {
			point_id: pointIdRequired,
			warehouse_id: z.number().int().positive().describe('Склад этой точки из mison_receipt_warehouses'),
			supplier_id: z.number().int().positive().describe('Поставщик из mison_receipt_suppliers'),
			items: z
				.array(
					z.object({
						product_id: z.number().int().positive().describe('Товар из mison_receipt_products'),
						quantity: z.number().positive().describe('Количество в единице товара'),
						price: z.number().positive().describe('Цена закупки за единицу'),
					}),
				)
				.min(1)
				.max(200)
				.describe('Строки накладной; один товар — одна строка'),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Дата прихода YYYY-MM-DD; без неё — сейчас'),
			note: z.string().max(500).optional().describe('Примечание, например номер накладной поставщика'),
			is_draft: z.boolean().optional().describe('true — черновик без проводок (остаток и долг не меняются); без параметра приход проводится сразу'),
			external_id: z.string().max(100).optional().describe('Идентификатор накладной; не передавайте — вернёте тот, что дал первый вызов'),
		},
		summary: (args) => {
			const lines = args.items.map((item) => `  • товар ${item.product_id}: ${fmt(item.quantity)} × ${fmt(item.price)} = ${fmt(money(item.quantity * item.price))}`)
			const total = money(args.items.reduce((sum, item) => sum + item.quantity * item.price, 0))
			args.external_id = args.external_id || newExternalId()
			return [
				`Точка ${args.point_id}, склад ${args.warehouse_id}, поставщик ${args.supplier_id}, дата ${args.date || 'сегодня'}.`,
				...lines,
				args.is_draft
					? `Итого: ${fmt(total)}. Это ЧЕРНОВИК: остаток и долг не изменятся, провести его можно в кабинете.`
					: `Итого: ${fmt(total)}. Приход проведётся сразу, остаток и долг поставщику изменятся.`,
				args.note ? `Примечание: ${args.note}` : null,
				`При повторном вызове передайте external_id=${args.external_id}.`,
			]
				.filter(Boolean)
				.join('\n')
		},
		run: (args, client) => client.request('POST', '/receipts', { body: { ...args, external_id: args.external_id || newExternalId() }, idempotent: true }),
	}),
]
