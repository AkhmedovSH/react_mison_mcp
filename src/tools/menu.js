// Меню: витрины, товары с ценами, номенклатура.

import { z } from 'zod'
import { getTool, pointIdRequired } from './define.js'

const g = 'menu'

export const menuTools = [
	getTool({
		name: 'mison_menus',
		group: g,
		title: 'Витрины меню',
		description: 'Список витрин меню, доступных ключу. id витрины нужен для mison_menu.',
		path: '/menus',
	}),
	getTool({
		name: 'mison_menu',
		group: g,
		title: 'Меню точки',
		description:
			'Витрина целиком для точки: категории и товары с ценами, модификаторами и доступностью (is_available). product_id товара нужен для заказа. Ответ большой — берите, когда нужно меню, а не для поиска одного товара.',
		path: '/menus/{id}',
		pathParams: ['id'],
		input: {
			id: z.number().int().positive().describe('id витрины из mison_menus'),
			point_id: pointIdRequired,
		},
	}),
	getTool({
		name: 'mison_nomenclature',
		group: g,
		title: 'Номенклатура точки',
		description: 'Плоский список товаров точки с категориями, без привязки к витрине. Для поиска product_id по названию.',
		path: '/nomenclature',
		input: { point_id: pointIdRequired },
	}),
]
