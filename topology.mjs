import { distance } from './geometry.mjs';
import { exactLineContact } from './native-contact.mjs';
import { inspectNativeChain } from './contour-inspection.mjs';

export function contoursForGroup(group) {
  if (Array.isArray(group.contours)) return group.contours;
  // Legacy projects retain the source references. Old duplicated groups cannot
  // safely use those IDs, which still refer to the original piece.
  if (!group.source?.duplicated && Array.isArray(group.source?.contourChains)) {
    return group.source.contourChains.map(chain => ({ role: chain.role, entityIds: [...chain.entityIds] }));
  }
  return [];
}

// Preserve serialized order. Dynamic programming chooses each curve's direction
// to minimize the sum of endpoint gaps around the entire cycle, including closure.
export function orientChain(entities) {
  if (!entities.length) return [];
  const endpoint = (entity, reverse, end) => {const points=entity.curve?.controlPoints||entity.points;return points[(Boolean(reverse) !== Boolean(end)) ? points.length - 1 : 0];};
  let best = null;
  for (let first = 0; first < 2; first++) {
    let costs = [Infinity, Infinity]; costs[first] = 0;
    const predecessors = [];
    for (let i = 1; i < entities.length; i++) {
      const next = [Infinity, Infinity], back = [];
      for (let current = 0; current < 2; current++) for (let previous = 0; previous < 2; previous++) {
        const cost = costs[previous] + distance(endpoint(entities[i - 1], previous, true), endpoint(entities[i], current, false));
        if (cost < next[current]) { next[current] = cost; back[current] = previous; }
      }
      predecessors[i] = back; costs = next;
    }
    for (let last = 0; last < 2; last++) {
      const cost = costs[last] + distance(endpoint(entities.at(-1), last, true), endpoint(entities[0], first, false));
      if (!best || cost < best.cost) {
        const directions = Array(entities.length); directions[entities.length - 1] = last;
        for (let i = entities.length - 1; i > 0; i--) directions[i - 1] = predecessors[i][directions[i]];
        best = { cost, directions };
      }
    }
  }
  return entities.map((entity, index) => ({ entity, reversed: Boolean(best.directions[index]), points: best.directions[index] ? [...entity.points].reverse() : entity.points }));
}

function properCrossing(a, b) {
  const contact=exactLineContact([a.start,a.end],[b.start,b.end]);return contact?.kind==='crossing'?contact:null;
}

export function inspectChain(entities, tolerance) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('容差必须是大于或等于零的有限数值');
  if (!entities.length || entities.some(entity => entity.type === 'text')) throw new Error('轮廓必须包含线条');
  const oriented = orientChain(entities), gaps = [], segments = [], issues = [];
  if (entities.length > 1 && entities.some(entity => entity.closed)) issues.push({ kind: 'mixed-closed', message: '多曲线链中含独立闭合图元，需核对边界定义' });
  for (let i = 0; i < oriented.length; i++) {
    const { entity, points } = oriented[i];
    const next = oriented[(i + 1) % oriented.length];
    if (!(oriented.length === 1 && entity.closed)) {
      const controls=entity.curve?.controlPoints,nextControls=next.entity.curve?.controlPoints,start=controls?(oriented[i].reversed?controls[0]:controls.at(-1)):points.at(-1),end=nextControls?(next.reversed?nextControls.at(-1):nextControls[0]):next.points[0],gap=distance(start,end);
      gaps.push({ start: { ...start }, end: { ...end }, distance: gap, entityIds: [entity.id, next.entity.id] });
      if (gap > tolerance) issues.push({ kind: 'gap', severity:'error', evidence:'source-endpoints', message: '端点间隙超出容差', distance: gap, start: { ...start }, end: { ...end },entityIds:[entity.id,next.entity.id] });
    }
    // Cached samples are presentation data, never evidence of native crossings.
    if(entity.curve)continue;
    for (let j = 0; j < points.length - (entity.closed ? 0 : 1); j++) {
      const start = points[j], end = points[(j + 1) % points.length];
      const segmentIndex=oriented[i].reversed?(points.length-2-j+points.length)%points.length:j,reference={entityId:entity.id,entityName:entity.name,kind:'line',segmentIndex,reversed:oriented[i].reversed};
      if (start.x===end.x&&start.y===end.y) {
        issues.push({ kind: 'zero-length',severity:'error',evidence:'source-points', message: '存在零长度线段', point: { ...start }, entityId: entity.id,entityIds:[entity.id],segmentIndex,highlights:[{controls:[{...start},{...end}],reference:{...reference}}] });
        continue;
      }
      segments.push({ start, end, entityId:entity.id,reference, minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) });
    }
  }
  // Broad-phase X/Y bounds avoid comparing most disjoint original line segments.
  segments.sort((a, b) => a.minX - b.minX);
  let comparisons = 0, truncated = false;
  outer: for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length && segments[j].minX <= segments[i].maxX; j++) {
    if (++comparisons > 2000000) { truncated = true; break outer; }
    if (segments[j].minY > segments[i].maxY || segments[j].maxY < segments[i].minY) continue;
    const contact = properCrossing(segments[i], segments[j]);
    if (contact) issues.push({severity:'error',evidence:'exact-line-contact', message: '已证实原始直线段相交',...contact,kind:'crossing',entityIds:[...new Set([segments[i].entityId,segments[j].entityId])],highlights:[segments[i],segments[j]].map(s=>({controls:[{...s.start},{...s.end}],reference:{...s.reference}})) });
    if (issues.length >= 1000) { truncated = true; break outer; }
  }
  if (truncated) issues.push({ kind: 'incomplete-check',severity:'review',evidence:'inconclusive', message: '复杂度超过本次检查上限，交叉检查未完成' });
  let native;
  try{native=inspectNativeChain(oriented,tolerance);}catch(error){native={status:'not-checked',reason:'calculation-error',message:error.message,nativeLength:null,issues:[{kind:'native-unresolved',severity:'review',evidence:'inconclusive',message:'原生检查未完成：'+error.message,entityIds:entities.map(e=>e.id)}]};}
  for(const issue of native.issues)if(!(issue.kind==='native-contact'&&issues.some(i=>i.kind==='crossing')))issues.push(issue);
  if(native.status==='not-checked'&&!issues.length)issues.push({kind:'native-unresolved',severity:'review',evidence:'inconclusive',message:native.message,entityIds:entities.map(e=>e.id)});
  return {
    entityIds: entities.map(entity => entity.id), directions: oriented.map(item => item.reversed),
    curveLength: entities.reduce((total, entity) => total + entity.points.slice(1).reduce((sum,point,i)=>sum+distance(point,entity.points[i]),0) + (entity.closed?distance(entity.points[0],entity.points.at(-1)):0), 0),
    maxGap: gaps.reduce((maximum, gap) => Math.max(maximum, gap.distance), 0),
    gaps, issues, native,nativeLength:native.nativeLength,withinTolerance: !issues.length&&native.status==='verified',needsReview:issues.some(i=>i.severity==='review')&&!issues.some(i=>i.severity!=='review'),
  };
}

export function inspectProject(project, tolerance) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('容差必须是大于或等于零的有限数值');
  const byId = new Map(project.entities.map(entity => [entity.id, entity]));
  const covered = new Set(), results = [];
  let additionalChains = 0;
  for (const group of project.groups || []) {
    const contours = contoursForGroup(group);
    const primary = contours.filter(contour => contour.role === 'primary-contour');
    additionalChains += contours.length - primary.length;
    if (!primary.length) {
      results.push({ name: group.name, groupId: group.id, entityIds: [...group.entityIds], status: 'unverified', issues: [{ kind: 'undefined-contour', message: '尚未定义主轮廓' }] });
      continue;
    }
    for (const contour of primary) {
      const ids = contour.entityIds;
      const missing = ids.filter(id => !group.entityIds.includes(id) || !byId.has(id));
      const entities = ids.map(id => byId.get(id)).filter(Boolean);
      for (const id of ids) covered.add(id);
      const invalid = !ids.length || new Set(ids).size !== ids.length || missing.length || entities.some(entity => entity.type === 'text');
      const result = invalid
        ? { entityIds: ids.filter(id => group.entityIds.includes(id) && byId.has(id)), issues: [{ kind: 'invalid-reference', message: '主轮廓引用不完整或重复，需重新定义', missingIds: missing }] }
        : inspectChain(entities, tolerance);
      results.push({ ...result, name: group.name, groupId: group.id, status: invalid ? 'unverified' : result.withinTolerance ? 'within-tolerance' : result.needsReview?'needs-review':'issues' });
    }
  }
  for (const entity of project.entities) if (!covered.has(entity.id) && entity.type !== 'text' && entity.closed && entity.layer === 'outline') {
    const result = inspectChain([entity], tolerance);
    results.push({ ...result, name: entity.name, status: result.withinTolerance ? 'within-tolerance' : result.needsReview?'needs-review':'issues' });
  }
  return {
    format: 'zhiyi-contour-report', version: 2, name: project.name, sourceFile: project.metadata?.sourceFile || null, units: project.units, tolerance,
    calibration: project.calibration ? JSON.parse(JSON.stringify(project.calibration)) : null,
    additionalChains, results,
    scope: '主轮廓端点间隙、原始直线精确相交/接触/重叠及原生 Bezier 闭合证明。容差内间隙仅作已披露的临时直线连接；曲线证明失败为需核对，不等于已证明自交。未检查缝份语义、额外链或服装尺寸。curveLength保留旧版显示折线长，nativeLength为收敛的原生沿线长。检查不修改纸样。',
  };
}
