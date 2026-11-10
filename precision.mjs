import { distance, length, transform, validateProject } from './geometry.mjs';
import { curveLength } from './curves.mjs';
import { transformGradeVectors } from './grading-schema.mjs';

export function referenceLength(entity, mode = 'path') {
  if (!entity || entity.type === 'text') throw new Error('请选择一条线作为校准基准');
  if (!['path', 'chord'].includes(mode)) throw new Error('不支持的量测方式');
  if (mode === 'chord' && entity.closed) throw new Error('闭合轮廓没有独立的两个端点，请使用沿线总长');
  if (mode === 'path' && entity.curve && !curveLength(entity.curve).converged) throw new Error('弧长积分尚未达到精度要求，不能作为校准基准');
  const measured = mode === 'path' ? length(entity) : distance(entity.points[0], entity.points.at(-1));
  if (!Number.isFinite(measured) || measured <= 1e-9) throw new Error('基准长度为零，无法校准');
  return measured;
}

// Construct and validate a candidate before replacing the document or recording undo.
export function calibratedProject(project, factor, reference = { method: 'direct-factor' }) {
  if (!project.entities.length) throw new Error('工程为空，无法校准');
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('比例必须是大于零的有限数值');
  const next = JSON.parse(JSON.stringify(project));
  for (const entity of next.entities) transform(entity, point => ({ x: point.x * factor, y: point.y * factor }));
  transformGradeVectors(next,new Set(next.entities.map(entity=>entity.id)),p=>({x:p.x*factor,y:p.y*factor}));
  for(const recipe of next.seamAllowances||[]){
    recipe.distance=recipe.widthMode==='edges'?Math.sign(recipe.distance):recipe.distance*factor;recipe.signature=null;recipe.status='stale';
    for(const entry of recipe.edgeWidths||[])entry.width*=factor;
  }
  for(const recipe of next.notches||[]){
    if(recipe.mode!=='ratio')recipe.position*=factor;
    for(const key of ['depth','width','spacing'])recipe[key]*=factor;
    recipe.signature=null;recipe.status='stale';
  }
  for(const check of next.seamChecks||[]){
    for(const side of ['a','b']){check[side].trimStart*=factor;check[side].trimEnd*=factor;}
    if(check.easeMode==='mm')check.easeValue*=factor;
    for(const mark of check.landmarks||[])for(const side of ['a','b'])if(['start','end'].includes(mark[side].kind))mark[side].value*=factor;
    for(const target of check.sectionTargets||[])if(target.easeMode==='mm')target.easeValue*=factor;
    check.signature=null;check.status='stale';delete check.result;
  }
  const prior = project.calibration?.millimetersPerSourceUnit;
  const cumulative = (Number.isFinite(prior) && prior > 0 ? prior : 1) * factor;
  if (!Number.isFinite(cumulative) || cumulative <= 0) throw new Error('累计换算比例无效');
  const record = { ...reference, appliedFactor: factor, previousUnits: project.units, resultingMillimetersPerSourceUnit: cumulative };
  const history = Array.isArray(project.calibration?.history) ? project.calibration.history : [];
  next.units = 'mm';
  next.calibration = { millimetersPerSourceUnit: cumulative, confirmedByUser: true, last: record, history: [...history, record] };
  next.warnings = (next.warnings || []).filter(warning => !warning.includes('单位') && !warning.startsWith('用户确认换算：'));
  next.warnings.push('用户确认换算：1 原始单位 = ' + cumulative + ' mm。');
  return validateProject(next);
}

export function calibrateFromReference(project, entityId, knownMillimeters, mode = 'path') {
  if (!Number.isFinite(knownMillimeters) || knownMillimeters <= 0) throw new Error('已知长度必须是大于零的毫米数');
  const entity = project.entities.find(item => item.id === entityId);
  const measuredBefore = referenceLength(entity, mode);
  return calibratedProject(project, knownMillimeters / measuredBefore, {
    method: 'known-length', entityId, entityName: entity.name, mode, measuredBefore, knownMillimeters,
  });
}
