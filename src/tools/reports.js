// Отчёты и справочники: чтение. Описания написаны для модели — какой отчёт на какой вопрос.

import { z } from 'zod'
import { getTool, postReadTool, pointId, dateFrom, dateTo } from './define.js'

const g = 'reports'

const status = (values, extra = '') =>
	z
		.string()
		.optional()
		.describe(`Статус: ${values}. Можно несколько через запятую, all — все.${extra}`)

export const coreTools = [
	getTool({
		name: 'mison_points',
		group: 'core',
		title: 'Точки заведения',
		description:
			'Список точек (филиалов) бренда с id. Вызывайте первым: id точки (point_id, UUID) нужен почти всем остальным инструментам. Без него в отчётах будут цифры по всем точкам сразу.',
		path: '/points',
	}),
	getTool({
		name: 'mison_reference',
		group: 'core',
		title: 'Справочники',
		description:
			'Справочники для заказов и отчётов: payment_types — типы оплат точки (нужен point_id), order_types — типы заказа (зал, с собой, доставка), order_type_subs — подтипы заказа, cancel_causes — причины отмены.',
		path: '/{kind}',
		pathParams: ['kind'],
		input: {
			kind: z.enum(['payment_types', 'order_types', 'order_type_subs', 'cancel_causes']).describe('Какой справочник'),
			point_id: pointId,
		},
	}),
]

// Путь API использует дефис, у нас — подчёркивание в имени справочника
coreTools[1].run = (args, client) => {
	const { kind, ...query } = args
	return client.get('/' + kind.replace(/_/g, '-'), query)
}

export const reportTools = [
	getTool({
		name: 'mison_olap_columns',
		group: g,
		title: 'Поля OLAP-отчёта',
		description:
			'Каталог полей OLAP-отчёта продаж: какие группировки (group_by), показатели (measures) и фильтры есть у каждого вида отчёта. Вызывайте перед mison_olap_report, если не уверены в названии поля.',
		path: '/reports/olap/columns',
		input: { report_type: z.enum(['SALES', 'ORDERS', 'PAYMENTS']).optional().describe('Вид отчёта; без него — все') },
	}),
	postReadTool({
		name: 'mison_olap_report',
		group: g,
		title: 'OLAP-отчёт продаж',
		description:
			'Главный отчёт о продажах в любых разрезах: выручка, чеки, средний чек, себестоимость, прибыль, скидки, возвраты по дням, категориям, товарам, точкам, официантам, кассирам, типам оплат. ' +
			'SALES — продажи товаров, ORDERS — чеки, PAYMENTS — оплаты. Период до 92 дней. Точки передавайте в filters.point_ids, иначе цифры по всем точкам. ' +
			'Итог бери только через include_totals: из строк его складывать нельзя (чек с двумя блюдами попадает в строки обоих). ' +
			'«Топ-10» — order_by + limit. Если last_sync_at у точки отстаёт, отчёт за сегодня ещё вырастет — скажите об этом пользователю.',
		path: '/reports/olap',
		input: {
			report_type: z.enum(['SALES', 'ORDERS', 'PAYMENTS']).describe('SALES — товары, ORDERS — чеки, PAYMENTS — оплаты'),
			date_from: dateFrom,
			date_to: dateTo,
			group_by: z.array(z.string()).max(7).optional().describe('Группировки, до 7 (например date, category, product, point, waiter, cashier). Пусто — одна строка итога'),
			measures: z.array(z.string()).min(1).describe('Показатели (например quantity, net_amount, cost, gross_profit, cheques_count, avg_cheque)'),
			filters: z
				.looseObject({})
				.optional()
				.describe('Фильтры: point_ids (UUID), order_type_ids (1 зал, 2 с собой, 3 доставка), category_ids, menu_ids, product_ids, payment_type_ids, client_ids и др. Все — массивы'),
			order_by: z
				.object({ measure: z.string(), direction: z.enum(['asc', 'desc']).optional() })
				.optional()
				.describe('Сортировка по показателю из measures'),
			limit: z.number().int().positive().optional().describe('Оставить первые N строк после сортировки'),
			include_totals: z.boolean().optional().describe('true — добавить итог по всему отчёту'),
		},
	}),
	getTool({
		name: 'mison_menu_folders',
		group: g,
		title: 'Папки меню',
		description: 'Папки меню с вложенностью и id — для фильтра menu_ids в отчётах («продажи по разделу Мангал»).',
		path: '/reports/menu-folders',
		input: { point_id: pointId },
	}),
	getTool({
		name: 'mison_payroll',
		group: g,
		title: 'Зарплата сотрудников',
		description:
			'Зарплата по сотрудникам за период: оклад или почасовая, начисления по мотивационным программам (с базой, ставкой, штуками), премии, штрафы, налоги (tax_withheld_amount — удержано с сотрудника, tax_employer_amount — налог работодателя сверх зарплаты), выплаты, остаток долга (balance_end уже за вычетом удержаний). Период до 62 дней. Без point_id — все точки.',
		path: '/reports/payroll',
		input: { point_id: pointId, date_from: dateFrom, date_to: dateTo },
	}),
	getTool({
		name: 'mison_kpi_programs',
		group: g,
		title: 'KPI и программы мотивации',
		description:
			'KPI сотрудников — это программы мотивации. Отчёт отдаёт сами программы (тип, ставка: сумма или процент, за штуку или разово, ступени, на кого действует, какие разделы меню зачитываются) и итоги за период по сотрудникам: база, штуки, начислено. ' +
			'Ставка null — не заполнена, начислено будет 0: скажите об этом. Период до 62 дней.',
		path: '/reports/motivations',
		input: {
			date_from: dateFrom,
			date_to: dateTo,
			point_id: pointId,
			motivation_id: z.number().int().optional().describe('Одна программа'),
			status: status('active (по умолчанию), inactive'),
			with_employees: z.boolean().optional().describe('false — без списка сотрудников, только программы и итоги'),
		},
	}),
	getTool({
		name: 'mison_profit_loss',
		group: g,
		title: 'Прибыли и убытки',
		description:
			'P&L: выручка → себестоимость → валовая прибыль → расходы по статьям → чистая прибыль, по точкам и итогом. Для вопросов «сколько прибыли», «какие расходы самые большие». Период до 62 дней.',
		path: '/reports/profit-loss',
		input: { point_id: pointId, date_from: dateFrom, date_to: dateTo },
	}),
	getTool({
		name: 'mison_cash_shifts',
		group: g,
		title: 'Кассовые смены',
		description:
			'Кассовые смены с продажами и движением денег по типам оплат (как X-отчёт). state=open — смены, открытые сейчас, с наличными в кассе (cash_balance). Иначе — закрытые в периоде (до 92 дней). Смена не равна бизнес-дню.',
		path: '/reports/shifts',
		input: {
			state: z.enum(['open']).optional().describe('open — только открытые сейчас; даты тогда не нужны'),
			date_from: dateFrom.optional(),
			date_to: dateTo.optional(),
			point_id: pointId,
		},
	}),
	getTool({
		name: 'mison_cheques',
		group: g,
		title: 'Чеки',
		description:
			'Чеки. Без status — открытые сейчас (в работе, без периода). status=closed или deleted требует date_from/date_to, период до 31 дня. with_items=true — со строками. Для «последний чек» — status=closed, order=desc, limit=1. Страницы — after_id и limit (до 1000). ИСТОРИЯ ГОСТЯ: client_phone — чеки одного гостя по телефону (в любом виде); без status — закрытые, без дат — за всё время, новые сначала по 50; в ответе блок client (имя, телефон, число заказов). Так отвечайте на «покажи заказы по номеру +998…». Гость не найден — 404.',
		path: '/reports/cheques',
		input: {
			point_id: pointId,
			status: status('open (по умолчанию), closed, deleted или статус открытого чека', ' closed и deleted — только с датами.'),
			date_from: dateFrom.optional(),
			date_to: dateTo.optional(),
			order_type_ids: z.array(z.number().int()).optional().describe('1 зал, 2 с собой, 3 доставка'),
			client_phone: z.string().optional().describe('Телефон гостя в любом виде, например +998 90 249-77-79: история его заказов'),
			with_items: z.boolean().optional(),
			order: z.enum(['asc', 'desc']).optional(),
			after_id: z.number().int().optional().describe('Курсор: id последнего полученного чека'),
			limit: z.number().int().positive().max(1000).optional(),
		},
	}),
	getTool({
		name: 'mison_money_movements',
		group: g,
		title: 'Движение денег',
		description:
			'Движение денег по кассе, сейфу, банку и подотчёту: приходы и расходы по назначениям. source — cashbox, safe, cash, bank, accountable; direction — plus/minus; group_by — day, purpose, day_purpose. Период до 31 дня.',
		path: '/reports/money-movements',
		input: {
			date_from: dateFrom,
			date_to: dateTo,
			point_id: pointId,
			source: z.string().optional().describe('cashbox, safe, cash, bank, accountable — можно несколько через запятую'),
			direction: z.enum(['plus', 'minus']).optional(),
			group_by: z.enum(['day', 'purpose', 'day_purpose']).optional(),
			supplier_id: z.number().int().optional().describe('Только платежи этому поставщику'),
			status: status('posted (по умолчанию), deleted'),
		},
	}),
	getTool({
		name: 'mison_deletions',
		group: g,
		title: 'Что удаляли',
		description:
			'Лента удалений за период: товары, сотрудники (блокировки), клиенты, чеки и их позиции, приходы, инвентаризации и другие документы — кто, когда, что. Журнал ведётся с 03.09.2026.',
		path: '/reports/deletions',
		input: {
			date_from: dateFrom,
			date_to: dateTo,
			point_id: pointId,
			types: z.string().optional().describe('product, employee, client, cheque, cheque_item, receipt, inventory… через запятую'),
		},
	}),
	getTool({
		name: 'mison_registrations',
		group: g,
		title: 'Новые клиенты и организации',
		description: 'Сколько новых клиентов и организаций зарегистрировано за период, по дням или месяцам. Период до 366 дней.',
		path: '/reports/registrations',
		input: { date_from: dateFrom, date_to: dateTo, group_by: z.enum(['day', 'month']).optional() },
	}),
	getTool({
		name: 'mison_employees',
		group: g,
		title: 'Сотрудники',
		description: 'Список сотрудников с должностью и точкой. Заблокированный сотрудник — это уволенный (в Mison их блокируют, не удаляют). Телефоны и PIN не отдаются.',
		path: '/reports/employees',
		input: {
			point_id: pointId,
			status: status('active (по умолчанию), blocked, deleted'),
			search: z.string().optional().describe('Часть имени'),
		},
	}),
	getTool({
		name: 'mison_attendance_report',
		group: g,
		title: 'Посещаемость',
		description: 'Смены сотрудников по приходу и уходу за период: кто когда пришёл, ушёл и сколько отработал. Период до 62 дней.',
		path: '/reports/attendance',
		input: { date_from: dateFrom, date_to: dateTo, point_id: pointId },
	}),
	getTool({
		name: 'mison_organizations_debt',
		group: g,
		title: 'Организации и их долг',
		description: 'Организации-контрагенты (клиенты в долг) и их долг перед заведением. only_debt=true — только должники.',
		path: '/reports/organizations',
		input: { point_id: pointId, only_debt: z.boolean().optional() },
	}),
	getTool({
		name: 'mison_organization_payments',
		group: g,
		title: 'Оплаты организаций',
		description: 'Оплаты, поступившие от организаций-контрагентов за период (погашение долга).',
		path: '/reports/organization-payments',
		input: { date_from: dateFrom, date_to: dateTo, point_id: pointId, organization_id: z.number().int().optional() },
	}),
	getTool({
		name: 'mison_suppliers_debt',
		group: g,
		title: 'Поставщики и долг перед ними',
		description: 'Поставщики и баланс: минус — заведение должно поставщику, плюс — заплатило вперёд. only_debt=true — только те, кому должны.',
		path: '/reports/suppliers',
		input: { point_id: pointId, only_debt: z.boolean().optional() },
	}),
	getTool({
		name: 'mison_abc_xyz',
		group: g,
		title: 'ABC-XYZ анализ товаров',
		description:
			'ABC-анализ (вклад товара в выручку или прибыль) и XYZ-анализ (стабильность спроса по неделям). Только целые недели. Для вопросов «что убрать из меню», «что приносит прибыль».',
		path: '/reports/abc-xyz',
		input: {
			date_from: dateFrom,
			date_to: dateTo,
			point_id: pointId,
			abc_by: z.string().optional().describe('По чему считать ABC, например gross_profit или revenue'),
			bucket: z.enum(['week', 'day']).optional(),
			with_series: z.boolean().optional().describe('Добавить ряд продаж по периодам'),
			menu_ids: z.string().optional().describe('Папки меню через запятую'),
			category_ids: z.string().optional(),
		},
	}),
	getTool({
		name: 'mison_products',
		group: g,
		title: 'Список товаров с ценами',
		description:
			'Справочник товаров: цена сейчас, себестоимость, фудкост, продаётся ли, стоп. Товар один раз, по точкам — массив points. Для «сколько стоит», «какой фудкост у блюда».',
		path: '/reports/products',
		input: {
			point_id: pointId,
			types: z.string().optional().describe('item, product, prep, modifier, service через запятую'),
			status: status('active (по умолчанию), inactive, deleted'),
			menu_ids: z.string().optional().describe('Папки меню через запятую, с вложенными'),
			search: z.string().optional().describe('Часть названия'),
		},
	}),
	getTool({
		name: 'mison_stop_list',
		group: g,
		title: 'Стоп-лист',
		description: 'Товары в стоп-листе сейчас и сколько дней. min_days — только те, что в стопе не меньше N дней.',
		path: '/reports/stop-list',
		input: { point_id: pointId, min_days: z.number().int().optional() },
	}),
	getTool({
		name: 'mison_stock',
		group: g,
		title: 'Остатки на складах',
		description:
			'Остатки по складам точек на дату (по умолчанию сегодня): количество, себестоимость, сумма. only_negative=true — только отрицательные остатки; with_last_receipt=true — с последним приходом.',
		path: '/reports/stock',
		input: {
			point_id: pointId,
			date: dateFrom.optional().describe('Дата остатка, YYYY-MM-DD'),
			only_negative: z.boolean().optional(),
			with_last_receipt: z.boolean().optional(),
		},
	}),
	getTool({
		name: 'mison_receipts_report',
		group: g,
		title: 'Приходы от поставщиков (отчёт)',
		description:
			'Приходные накладные за период: по документам, поставщикам (group_by=supplier), товарам (product) или ценам (price — как менялась закупочная цена). only_changed и min_change_percent — найти скачки цены. Для вопросов «у кого дешевле», «когда подорожало».',
		path: '/reports/receipts',
		input: {
			date_from: dateFrom,
			date_to: dateTo,
			point_id: pointId,
			status: status('posted (по умолчанию), draft, deleted'),
			group_by: z.enum(['document', 'supplier', 'product', 'price']).optional(),
			supplier_id: z.number().int().optional(),
			product_id: z.number().int().optional(),
			only_changed: z.boolean().optional(),
			min_change_percent: z.number().optional(),
		},
	}),
	getTool({
		name: 'mison_inventories_report',
		group: g,
		title: 'Инвентаризации (отчёт)',
		description: 'Инвентаризации за период: даты, склады, недостача и излишек в деньгах. with_items=true — со строками по товарам.',
		path: '/reports/inventories',
		input: {
			date_from: dateFrom,
			date_to: dateTo,
			point_id: pointId,
			status: status('posted (по умолчанию), draft, deleted'),
			with_items: z.boolean().optional(),
		},
	}),
	getTool({
		name: 'mison_stock_movements',
		group: g,
		title: 'Движение товаров на складе',
		description: 'Журнал движений товаров: приходы, расходы, списания, инвентаризации. Период до 31 дня; страницы — after_id и limit.',
		path: '/reports/stock-movements',
		input: {
			point_id: pointId,
			date_from: dateFrom,
			date_to: dateTo,
			after_id: z.number().int().optional(),
			limit: z.number().int().positive().max(1000).optional(),
		},
	}),
	getTool({
		name: 'mison_subscriptions',
		group: g,
		title: 'Подписка на Mison',
		description: 'Какие услуги Mison подключены у точек (фискализация, AI-ассистент, SMS) и до какого числа оплачены.',
		path: '/reports/subscriptions',
		input: { point_id: pointId },
	}),
]
