/**
 * Shared pieces of the command catalogue: JSON Schema builders, the validator for the
 * schema subset in use, and small project lookups. Kept apart so that command modules
 * can share them without importing each other.
 */
export const LIMIT = 100000;
export const number = (minimum, maximum, description) => ({ type: 'number', minimum, maximum, description });
export const point = description => ({ type: 'object', description, properties: { x: number(-LIMIT, LIMIT, '横坐标，毫米，向右为正'), y: number(-LIMIT, LIMIT, '纵坐标，毫米，向上为正') }, required: ['x', 'y'], additionalProperties: false });
export const idList = (description, minItems = 1) => ({ type: 'array', description, items: { type: 'string', minLength: 1, maxLength: 120 }, minItems, maxItems: 5000 });
export const text = (maxLength, description) => ({ type: 'string', minLength: 1, maxLength, description });
export const object = (properties, required, description) => ({ type: 'object', description, properties, required, additionalProperties: false });
export const layer = { type: 'string', enum: ['outline', 'internal'], description: 'outline 为净样或普通线，internal 为内部线' };

/** Validate a value against the JSON Schema subset used by the command set. */
export function validateInput(schema, value, path = '参数') {
  const fail = message => { throw new Error(path + message); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象。');
    for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) fail('含未定义的字段“' + key + '”。');
    for (const key of schema.required || []) if (value[key] === undefined) fail('缺少“' + key + '”。');
    for (const [key, child] of Object.entries(schema.properties)) if (value[key] !== undefined) validateInput(child, value[key], path + '.' + key);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('必须是数组。');
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('的数量须在 ' + (schema.minItems ?? 0) + ' 至 ' + schema.maxItems + ' 之间。');
    value.forEach((item, index) => validateInput(schema.items, item, path + '[' + index + ']'));
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('必须是有限数字。');
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) fail('须在 ' + schema.minimum + ' 至 ' + schema.maximum + ' 之间。');
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('须大于 ' + schema.exclusiveMinimum + '。');
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('必须是文字。');
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) fail('的长度不符合要求。');
    if (schema.enum && !schema.enum.includes(value)) fail('须为 ' + schema.enum.join('、') + ' 之一。');
    if ([...value].some(c => c.codePointAt(0) < 32)) fail('含控制字符。');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail('必须是布尔值。');
  } else throw new Error('命令定义的参数类型无效。');
  return value;
}


// ---------------------------------------------------------------- project lookups
export const requireMm = project => { if (project.units !== 'mm') throw new Error('当前工程的单位未确认为毫米，不能执行绘图命令。'); };
export const samePoint = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
export function entityOf(project, id) { const entity = project.entities.find(e => e.id === id); if (!entity) throw new Error('找不到图元 ' + id + '。'); return entity; }
export function groupOf(project, id) { const group = (project.groups || []).find(g => g.id === id); if (!group) throw new Error('找不到裁片 ' + id + '。'); return group; }
export function addEntity(project, env, entity) { const created = { id: env.makeId(), closed: false, layer: 'outline', ...entity }; project.entities.push(created); return created; }
export function assertWholePieces(project, ids) {
  for (const group of project.groups || []) if (group.entityIds.some(id => ids.has(id)) && !group.entityIds.every(id => ids.has(id))) throw new Error('需包含完整裁片“' + group.name + '”，不能只处理其中一部分。');
}
export function existingIds(project, list) { const ids = new Set(list); if (ids.size !== list.length) throw new Error('图元列表有重复。'); for (const id of ids) entityOf(project, id); return ids; }
export const round = value => Math.round(value * 1000) / 1000;
