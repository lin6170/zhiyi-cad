/**
 * Validator for the JSON Schema subset the command catalogue uses (the same subset the
 * page checks before it runs a command). Returns a list of problems instead of throwing,
 * so that all of them can be handed back to the model in one correction round.
 */
const MAX_PROBLEMS = 12;

export function schemaProblems(schema, value, path = 'parameters', problems = []) {
  const add = message => { if (problems.length < MAX_PROBLEMS) problems.push(path + ' ' + message); };
  if (!schema || typeof schema !== 'object') { add('没有可用的参数定义'); return problems; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { add('必须是对象'); return problems; }
    const properties = schema.properties || {};
    for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) add('含命令定义里没有的字段“' + key + '”');
    for (const key of schema.required || []) if (value[key] === undefined) add('缺少“' + key + '”');
    for (const [key, child] of Object.entries(properties)) if (value[key] !== undefined) schemaProblems(child, value[key], path + '.' + key, problems);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { add('必须是数组'); return problems; }
    const least = schema.minItems ?? 0, most = schema.maxItems ?? Infinity;
    if (value.length < least || value.length > most) add('的数量须在 ' + least + ' 至 ' + most + ' 之间');
    value.slice(0, 5000).forEach((item, index) => { if (problems.length < MAX_PROBLEMS) schemaProblems(schema.items, item, path + '[' + index + ']', problems); });
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) { add(schema.type === 'integer' ? '必须是整数' : '必须是数字'); return problems; }
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) add('须在 ' + schema.minimum + ' 至 ' + schema.maximum + ' 之间');
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) add('须大于 ' + schema.exclusiveMinimum);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') { add('必须是文字'); return problems; }
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) add('的长度须在 ' + (schema.minLength ?? 0) + ' 至 ' + (schema.maxLength ?? '不限') + ' 个字符之间');
    if (schema.enum && !schema.enum.includes(value)) add('须为 ' + schema.enum.join('、') + ' 之一');
    if ([...value].some(c => c.codePointAt(0) < 32)) add('含控制字符');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') add('必须是 true 或 false');
  } else add('的参数类型“' + String(schema.type) + '”不在支持范围内');
  return problems;
}
