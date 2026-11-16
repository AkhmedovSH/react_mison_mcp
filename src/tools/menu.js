// Меню: витрины, товары с ценами, номенклатура.

import { z } from 'zod'
import { getTool, pointIdRequired } from './define.js'

const g = 'menu'

export const menuTools = [
	getTool({
		name: 'mison_menus',
		group: g,
		title: 'Витрины меню',
		description:
			'Список меню, доступных ключу. id нужен для mison_menu. Если у ключа не выбрана витрина, в списке одна запись «Основное меню» с id 0.',
		path: '/menus',
	}),
	getTool({
		name: 'mison_menu',
		group: g,
		title: 'Меню точки',
		description:
			'Меню целиком для точки: категории и товары с ценами, модификаторами и доступностью (is_available). id 0 — основное меню заведения для ключа без витрины, в той же структуре (разделы и товары, выставленные гостям; весь каталог — mison_nomenclature). product_id товара нужен для заказа. Ответ большой — берите, когда нужно меню, а не для поиска одного товара.',
		path: '/menus/{id}',
		pathParams: ['id'],
		input: {
			id: z.number().int().nonnegative().describe('id из mison_menus; 0 — основное меню'),
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
