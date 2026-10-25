// Сборка MCP-сервера Mison: общая для локального запуска (stdio) и удалённого (HTTP).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFileSync } from 'node:fs'
import { registerTools } from './tools/index.js'

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export const INSTRUCTIONS = [
	'Mison — система учёта для заведений общепита: продажи, склад, зарплата, брони.',
	'Начните с mison_points: id точки (point_id) нужен почти всем инструментам; без него отчёты считаются по всем точкам.',
	'Для вопросов «сколько продали» — mison_olap_report, «сколько заработал сотрудник» — mison_payroll, «KPI» — mison_kpi_programs, «прибыль» — mison_profit_loss, «что на складе» — mison_stock.',
	'Деньги и количества приходят в сумах и штуках как есть. Отчёты за сегодня ещё не окончательные, если касса не досинхронизирована.',
	'Инструменты записи (приход, заказ, бронь, отметки, отмена) ничего не отправляют без confirmed=true: сначала покажите человеку итог и дождитесь явного «да».',
	'Идентификаторы (point_id, warehouse_id, supplier_id, product_id) берите из справочных инструментов, не придумывайте.',
	'Инвентаризация: сначала mison_inventory_preview и показ сумм недостачи человеку; создавайте черновик, а проводить сразу (is_draft=false) только по явной просьбе и с check из расчёта.',
	'Перемещения: между своими складами проводятся сразу; на другой логин (mison_transfer_external) по умолчанию черновик — отправлять сразу только по явной просьбе, показав получателя, состав и суммы.',
].join('\n')

/** MCP-сервер с инструментами под данный клиент API и набор групп/режим «только чтение» */
export function createMisonServer({ client, groups, readonly = false }) {
	const server = new McpServer({ name: 'mison', version: VERSION }, { instructions: INSTRUCTIONS })
	const tools = registerTools(server, client, { groups, readonly })
	return { server, tools }
}
