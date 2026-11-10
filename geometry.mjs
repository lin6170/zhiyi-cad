import { curveLength, refreshCurve } from './curves.mjs';
import { validateNotches } from './notches.mjs';
import { normalizeEdgeWidths } from './seam-widths.mjs';
import { validateSeamChecks } from './seam-checks.mjs';
import { validateGradingPlans } from './grading-schema.mjs';
import { validateMarkerPlans } from './marker-schema.mjs';
import { validatePlotSettings } from './plot-schema.mjs';
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function textWidth(text, height) {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 1 : .6), 0) * height;
}
export function textCorners(entity) {
  const angle = (entity.rotation || 0) * Math.PI / 180;
  const width = entity.width || textWidth(entity.text, entity.height), height = entity.height * (entity.mirrorY ? -1 : 1);
  const x = { x: Math.cos(angle) * width, y: Math.sin(angle) * width };
  const y = { x: -Math.sin(angle) * height, y: Math.cos(angle) * height };
  const anchor = entity.points[0], offset = entity.verticalAlign === 'middle' ? .5 : 0;
  const origin = { x: anchor.x - y.x * offset, y: anchor.y - y.y * offset };
  return [origin, { x: origin.x + x.x, y: origin.y + x.y }, { x: origin.x + x.x + y.x, y: origin.y + x.y + y.y }, { x: origin.x + y.x, y: origin.y + y.y }];
}
export function bounds(entities) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const entity of entities) for (const p of entity.type === 'text' ? textCorners(entity) : entity.points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } : null;
}
export function length(entity) {
  if (entity.type === 'text') return 0;
  if (entity.curve) return curveLength(entity.curve).value + (entity.closed ? distance(entity.points.at(-1),entity.points[0]) : 0);
  let result = 0;
  for (let i = 1; i < entity.points.length; i++) result += distance(entity.points[i - 1], entity.points[i]);
  if (entity.closed) result += distance(entity.points.at(-1), entity.points[0]);
  return result;
}
export function transform(entity, fn) {
  if (entity.type === 'text') {
    const corners = textCorners(entity).map(fn);
    const x = { x: corners[1].x - corners[0].x, y: corners[1].y - corners[0].y };
    const y = { x: corners[3].x - corners[0].x, y: corners[3].y - corners[0].y };
    entity.width = distance(corners[0], corners[1]);
    entity.height = distance(corners[0], corners[3]);
    entity.rotation = Math.atan2(x.y, x.x) * 180 / Math.PI;
    entity.mirrorY = x.x * y.y - x.y * y.x < 0;
  }
  entity.points = entity.points.map(fn);
  if (entity.curve) {
    const origin=fn({x:0,y:0}),x=fn({x:1,y:0}),y=fn({x:0,y:1});
    const scale=Math.max(distance(origin,x),distance(origin,y));
    entity.curve={...entity.curve,controlPoints:entity.curve.controlPoints.map(fn),knots:[...entity.curve.knots],samplingTolerance:(entity.curve.samplingTolerance??.002)*scale};
  }
  // Retain imported source data for inspection, but never treat it as the edited geometry.
  if (entity.source) entity.source.modified = true;
}
export function quadratic(a, control, b, steps = 48) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * control.x + t * t * b.x, y: u * u * a.y + 2 * u * t * control.y + t * t * b.y };
  });
}
export function pointOnSegment(p, a, b) {
  const squared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / squared)) : 0;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}
export function validateProject(value) {
  if (!value || value.format !== 'zhiyi-cad' || ![1,2,3,4,5,6,7,8,9,10].includes(value.version) || !Array.isArray(value.entities)) throw new Error('无法识别的工程格式');
  if (!['mm', 'unknown'].includes(value.units)) throw new Error('工程单位无效');
  value.name = String(value.name || '未命名纸样');
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some(w => typeof w !== 'string'))) throw new Error('工程报告字段无效');
  if (value.metadata?.format !== undefined && typeof value.metadata.format !== 'string') throw new Error('工程元数据无效');
  if (value.entities.length > 30000) throw new Error('图元数量超过限制');
  let total = 0;
  const ids = new Set();
  for (const entity of value.entities) {
    if (!entity || typeof entity.id !== 'string' || ids.has(entity.id) || !Array.isArray(entity.points) || entity.points.length < (entity.type === 'text' ? 1 : 2)) throw new Error('工程图元数据不完整');
    if (entity.curve !== undefined) {
      if (entity.type === 'text') throw new Error('文字不能包含曲线定义');
      refreshCurve(entity);value.version=Math.max(value.version,2);
    }
    if (entity.type === 'text') {
      if (entity.points.length !== 1 || typeof entity.text !== 'string' || entity.text.length > 10000 || !Number.isFinite(entity.height) || entity.height <= 0 || entity.height > 1e6) throw new Error('工程文字数据无效');
      if (entity.width !== undefined && (!Number.isFinite(entity.width) || entity.width <= 0 || entity.width > 1e8)) throw new Error('文字宽度无效');
      if (entity.rotation !== undefined && !Number.isFinite(entity.rotation)) throw new Error('文字角度无效');
      if (entity.emptyTextReference !== undefined && (typeof entity.emptyTextReference !== 'string' || entity.emptyTextReference.length > 10000)) throw new Error('空文字的排版参考无效');
    }
    ids.add(entity.id);
    total += entity.points.length;
    for (const p of entity.points) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e8 || Math.abs(p.y) > 1e8) throw new Error('工程包含无效坐标');
    entity.name = String(entity.name || '未命名图元');
    entity.closed = Boolean(entity.closed);
    entity.layer = String(entity.layer || 'outline');
  }
  if (total > 1000000) throw new Error('节点数量超过限制');
  if (value.groups === undefined) value.groups = [];
  if (!Array.isArray(value.groups) || value.groups.length > 30000) throw new Error('工程组合数据无效');
  const groupIds = new Set(), assigned = new Set();
  for (const group of value.groups) {
    if (!group || typeof group.id !== 'string' || groupIds.has(group.id) || !Array.isArray(group.entityIds) || group.entityIds.length < 2) throw new Error('工程组合结构无效');
    groupIds.add(group.id); group.name = String(group.name || '未命名组合');
    if (group.contours !== undefined) {
      if (!Array.isArray(group.contours) || group.contours.length > 1000) throw new Error('轮廓定义无效');
      for (const contour of group.contours) {
        if (!contour || !['primary-contour', 'additional-chain'].includes(contour.role) || !Array.isArray(contour.entityIds) || contour.entityIds.length > 10000 || contour.entityIds.some(id => typeof id !== 'string')) throw new Error('轮廓定义无效');
        // Missing members may result from deleting a boundary segment. Keep the
        // definition for diagnosis, rather than silently joining its neighbors.
      }
    }
    for (const id of group.entityIds) {
      if (!ids.has(id) || assigned.has(id)) throw new Error('组合包含无效或重复的图元引用');
      assigned.add(id);
    }
  }
  if(value.seamAllowances===undefined)value.seamAllowances=[];
  if(!Array.isArray(value.seamAllowances)||value.seamAllowances.length>1000)throw new Error('缝份关联定义无效');
  const recipeIds=new Set(),outputs=new Set(),byId=new Map(value.entities.map(entity=>[entity.id,entity]));
  for(const recipe of value.seamAllowances){
    if(!recipe||typeof recipe.id!=='string'||recipeIds.has(recipe.id)||typeof recipe.name!=='string'||typeof recipe.basisLabel!=='string'||!Array.isArray(recipe.baseEntityIds)||!recipe.baseEntityIds.length||recipe.baseEntityIds.length>2000||recipe.baseEntityIds.some(id=>typeof id!=='string')||new Set(recipe.baseEntityIds).size!==recipe.baseEntityIds.length||!Array.isArray(recipe.outputIds)||!recipe.outputIds.length||recipe.outputIds.length>1000)throw new Error('缝份关联定义无效');
    recipeIds.add(recipe.id);
    Object.assign(recipe,normalizeEdgeWidths(recipe,recipe.baseEntityIds));
    if(recipe.widthMode==='edges')value.version=Math.max(value.version,5);
    for(const id of recipe.outputIds){const entity=byId.get(id);if(outputs.has(id)||!entity||entity.derivedFrom!==recipe.id||!entity.closed||entity.type==='text'||entity.curve)throw new Error('缝份输出引用无效');outputs.add(id);}
    if(!Number.isFinite(recipe.distance)||Math.abs(recipe.distance)<.001||Math.abs(recipe.distance)>1e6||!['miter','round','square'].includes(recipe.join)||!Number.isFinite(recipe.miterLimit)||recipe.miterLimit<2||recipe.miterLimit>20||!Number.isFinite(recipe.gapTolerance)||recipe.gapTolerance<0||recipe.gapTolerance>10||!['curveTolerance','arcTolerance'].every(key=>Number.isFinite(recipe[key])&&recipe[key]>=.001&&recipe[key]<=.5))throw new Error('缝份参数无效');
    if(recipe.baseEntityIds.some(id=>byId.get(id)?.derivedFrom||byId.get(id)?.notchFrom))throw new Error('不支持派生图元之间的循环或嵌套关联');
    recipe.signature=null;recipe.status='stale';
  }
  for(const entity of value.entities)if(entity.derivedFrom!==undefined&&(!recipeIds.has(entity.derivedFrom)||!outputs.has(entity.id)))throw new Error('图元的缝份关联缺失');
  if(value.seamAllowances.length)value.version=Math.max(value.version,3);
  validateNotches(value);
  validateSeamChecks(value);
  validateGradingPlans(value);
  validateMarkerPlans(value);
  validatePlotSettings(value);
  return value;
}
export { toDxf, fromDxf } from './dxf.mjs';
