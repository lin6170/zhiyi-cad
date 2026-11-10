import { textWidth } from './geometry.mjs';

/** Shared text edit for properties, table cells and future command callers. */
export function replaceAnnotationText(entity, value) {
  if (entity?.type !== 'text' || typeof value !== 'string' || value.length > 10000 || /[\r\n]/.test(value)) {
    throw new Error('文字修改无效；请选择文字对象并输入不含换行的内容。');
  }
  if (entity.text === value) return false;
  const reference = entity.text || (typeof entity.emptyTextReference === 'string' ? entity.emptyTextReference : '');
  const oldWidth = textWidth(reference, entity.height), newWidth = textWidth(value, entity.height);
  let width = entity.width;
  if (newWidth > 0 && (newWidth !== oldWidth || width === undefined)) width = oldWidth > 0 ? (width || oldWidth) * newWidth / oldWidth : newWidth;
  if (width !== undefined && (!Number.isFinite(width) || width <= 0 || width > 1e8)) throw new Error('修改后的文字宽度超出可用范围。');
  if (newWidth > 0) { entity.width = width; delete entity.emptyTextReference; }
  else if (entity.text) entity.emptyTextReference = entity.text;
  entity.text = value; entity.name = value || '空文字';
  if (entity.source) entity.source.modified = true;
  return true;
}
