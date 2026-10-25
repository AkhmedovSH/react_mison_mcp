// Перемещения: между складами одной точки и на точку другого логина.

import { z } from 'zod'
import { getTool, writeTool, pointIdRequired, newExternalId } from './define.js'

const g = 'transfers'

const fmt = (value) => new Intl.NumberFormat('ru-RU').format(value)

const warehouse = (label) => z.number().int().positive().describe(label)

const lines = (withPrice) =>
	z
		.array(
			z.object({
				product_id: z.number().int().positive().describe('Товар из mison_transfer_stock'),
				quantity: z.number().positive().describe('Количество в единице товара'),
				...(withPrice
					? { sale_price: z.number().min(0).optional().describe('Цена для получателя за единицу; без неё — цена продажи из карточки, иначе себестоимость. От неё считается долг получателя') }
					: {}),
			}),
		)
		.min(1)
		.max(200)
		.describe('Что перемещаем; один товар — одна строка')

export const transferTools = [
	getTool({
		name: 'mison_transfer_recipients',
		group: g,
		title: 'Получатели внешних перемещений',
		description:
			'Точки других логинов, на которые эта точка может отправлять товар (получатель сам разрешил отгрузку), и их склады. recipient_id — это to_point_id для mison_transfer_external. Если список пуст — отправлять некому, договариваться нужно в кабинете.',
		path: '/transfers/recipients',
		input: { point_id: pointIdRequired },
	}),
	getTool({
		name: 'mison_transfer_stock',
		group: g,
		title: 'Что на складе для перемещения',
		description:
			'Остатки склада с себестоимостью и ценой продажи: от этого собирают перемещение. can_transfer_external=false — товар списывается по техкарте, на другой логин через API его не отправить (только между своими складами или в кабинете). Ищите по части названия; only_with_balance=true — только то, что есть на складе.',
		path: '/transfers/stock',
		input: {
			point_id: pointIdRequired,
			warehouse_id: warehouse('Склад из mison_receipt_warehouses'),
			search: z.string().optional().describe('Часть названия'),
			only_with_balance: z.boolean().optional(),
			limit: z.number().int().positive().max(200).optional(),
		},
	}),
	writeTool({
		name: 'mison_transfer_internal',
		group: g,
		title: 'Переместить между складами',
		description:
			'Перемещает товар между складами ОДНОЙ точки: ПРОВОДИТСЯ СРАЗУ — остаток уходит со склада-источника и приходит на склад-получатель. Деньги не двигаются. ' +
			'Себестоимость и остаток считает сервер; не хватает остатка — 409 и список нехваток, ничего не записывается. Отменить можно только удалением документа в кабинете. ' +
			'Склады берите из mison_receipt_warehouses, товары из mison_transfer_stock, не угадывайте. Покажите человеку, что и откуда куда, и дождитесь «да». Повтор с тем же external_id документ не дублирует.',
		idempotent: true,
		input: {
			point_id: pointIdRequired,
			from_warehouse_id: warehouse('Склад-источник'),
			to_warehouse_id: warehouse('Склад-получатель той же точки'),
			items: lines(false),
			note: z.string().max(500).optional(),
			external_id: z.string().max(100).optional().describe('Не передавайте — вернёте тот, что дал первый вызов'),
		},
		summary: (args) => {
			args.external_id = args.external_id || newExternalId()
			return [
				`Точка ${args.point_id}: со склада ${args.from_warehouse_id} на склад ${args.to_warehouse_id}.`,
				...args.items.map((item) => `  • товар ${item.product_id}: ${fmt(item.quantity)}`),
				'Перемещение будет ПРОВЕДЕНО СРАЗУ: остаток источника уменьшится, получателя — вырастет.',
				args.note ? `Примечание: ${args.note}` : null,
				`При повторном вызове передайте external_id=${args.external_id}.`,
			]
				.filter(Boolean)
				.join('\n')
		},
		run: (args, client) => client.request('POST', '/transfers/internal', { body: { ...args, external_id: args.external_id || newExternalId() }, idempotent: true }),
	}),
	writeTool({
		name: 'mison_transfer_external',
		group: g,
		title: 'Отправить товар на другой логин',
		description:
			'Отгрузка на точку ДРУГОГО логина (партнёру). ПО УМОЛЧАНИЮ — ЧЕРНОВИК: остаток и долг не двигаются, человек проверит и отправит в кабинете. ' +
			'Отправить сразу (is_draft=false) — только по явной просьбе и после того, как человек увидел получателя, состав и суммы: у вас спишется остаток, получателю поставится долг на сумму по ценам продажи и уйдёт уведомление; он примет товар у себя в кабинете. ' +
			'Получателя и его склад берите из mison_transfer_recipients (только тот, кто разрешил отгрузку), товары — из mison_transfer_stock; товары по техкарте через API не уходят. ' +
			'Не хватает остатка при отправке — 409. Отменить отправленное можно только удалением в кабинете. Повтор с тем же external_id документ не дублирует.',
		destructive: true,
		idempotent: true,
		input: {
			point_id: pointIdRequired,
			from_warehouse_id: warehouse('Склад-источник'),
			to_point_id: z.string().describe('recipient_id из mison_transfer_recipients'),
			to_warehouse_id: warehouse('Склад получателя из mison_transfer_recipients; можно не указывать — выберет получатель').optional(),
			items: lines(true),
			is_draft: z.boolean().optional().describe('true (по умолчанию) — черновик; false — отправить сразу'),
			note: z.string().max(500).optional(),
			external_id: z.string().max(100).optional().describe('Не передавайте — вернёте тот, что дал первый вызов'),
		},
		summary: (args) => {
			args.external_id = args.external_id || newExternalId()
			const draft = args.is_draft !== false
			return [
				`Точка ${args.point_id}, склад ${args.from_warehouse_id} → получатель ${args.to_point_id}${args.to_warehouse_id ? `, его склад ${args.to_warehouse_id}` : ''}.`,
				...args.items.map((item) => `  • товар ${item.product_id}: ${fmt(item.quantity)}${item.sale_price !== undefined ? ` по ${fmt(item.sale_price)}` : ''}`),
				draft
					? 'Это ЧЕРНОВИК: остаток и долг не изменятся, человек отправит его в кабинете.'
					: 'Товар будет ОТПРАВЛЕН СРАЗУ: ваш остаток уменьшится, получателю поставится долг по ценам продажи, ему уйдёт уведомление.',
				args.note ? `Примечание: ${args.note}` : null,
				`При повторном вызове передайте external_id=${args.external_id}.`,
			]
				.filter(Boolean)
				.join('\n')
		},
		run: (args, client) => {
			const body = { ...args, is_draft: args.is_draft !== false, external_id: args.external_id || newExternalId() }
			return client.request('POST', '/transfers/external', { body, idempotent: true })
		},
	}),
	getTool({
		name: 'mison_get_transfer',
		group: g,
		title: 'Принятое перемещение',
		description:
			'Перемещение по external_id: internal — posted или deleted; external — draft (ждёт отправки в кабинете), sent (отправлено, получатель ещё не принял), accepted (принято), deleted. Со строками и суммами.',
		path: '/transfers',
		input: { external_id: z.string().describe('Тот external_id, с которым создавали перемещение') },
	}),
]
