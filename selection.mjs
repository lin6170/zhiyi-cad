import { bounds, textCorners, transform } from './geometry.mjs';
import { contoursForGroup } from './topology.mjs';
import { assertIndependentTransform } from './seams.mjs';
import { transformGradeVectors, prepareGradeVectorTransform } from './grading-schema.mjs';
import { transformMarkerGrains } from './transform-links.mjs';

export function expandGroups(project, ids) {
  const result = new Set(ids);
  for (const group of project.groups || []) {
    if (group.entityIds.some(id => result.has(id))) {
      for (const id of group.entityIds) result.add(id);
    }
  }
  return result;
}

export function selectionBounds(project, ids) {
  return bounds(project.entities.filter(entity => ids.has(entity.id)));
}

function inside(point, box) {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

function segmentIntersectsBox(start, end, box) {
  let enter = 0, leave = 1;
  const dx = end.x - start.x, dy = end.y - start.y;
  const directions = [-dx, dx, -dy, dy];
  const distances = [start.x - box.minX, box.maxX - start.x, start.y - box.minY, box.maxY - start.y];
  for (let i = 0; i < 4; i++) {
    if (directions[i] === 0) {
      if (distances[i] < 0) return false;
    } else {
      const ratio = distances[i] / directions[i];
      if (directions[i] < 0) enter = Math.max(enter, ratio);
      else leave = Math.min(leave, ratio);
      if (enter > leave) return false;
    }
  }
  return true;
}

export function entitiesInBox(entities, start, end, crossing) {
  const box = { minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) };
  const result = new Set();
  for (const entity of entities) {
    const points = entity.type === 'text' ? textCorners(entity) : entity.points;
    if (points.every(point => inside(point, box))) {
      result.add(entity.id);
      continue;
    }
    if (!crossing) continue;
    const closed = entity.closed || entity.type === 'text';
    for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
      if (segmentIntersectsBox(points[i], points[(i + 1) % points.length], box)) {
        result.add(entity.id);
        break;
      }
    }
  }
  return result;
}

export function moveSelection(project, ids, dx, dy) {
  assertIndependentTransform(project,ids);
  for (const entity of project.entities) if (ids.has(entity.id)) {
    transform(entity, point => ({ x: point.x + dx, y: point.y + dy }));
  }
}

export function rotateSelection(project, ids, degrees) {
  assertIndependentTransform(project,ids);
  const box = selectionBounds(project, ids);
  if (!box) return;
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  const angle = degrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  const commitGradeVectors=prepareGradeVectorTransform(project,ids,p=>({x:p.x*cosine-p.y*sine,y:p.x*sine+p.y*cosine}));
  for (const entity of project.entities) if (ids.has(entity.id)) {
    transform(entity, point => ({
      x: cx + (point.x - cx) * cosine - (point.y - cy) * sine,
      y: cy + (point.x - cx) * sine + (point.y - cy) * cosine,
    }));
  }
  commitGradeVectors();
  transformMarkerGrains(project,ids,p=>({x:p.x*cosine-p.y*sine,y:p.x*sine+p.y*cosine}));
}

export function mirrorSelection(project, ids) {
  assertIndependentTransform(project,ids);
  const box = selectionBounds(project, ids);
  if (!box) return;
  for (const entity of project.entities) if (ids.has(entity.id)) {
    transform(entity, point => ({ x: box.minX + box.maxX - point.x, y: point.y }));
  }
  for(const recipe of project.notches||[])if(ids.has(recipe.baseEntityId))recipe.side*=-1;
  transformGradeVectors(project,ids,p=>({x:-p.x,y:p.y}));
  transformMarkerGrains(project,ids,p=>({x:-p.x,y:p.y}));
}

function removeMembers(project, ids) {
  project.groups = (project.groups || []).map(group => {
    const remaining = group.entityIds.filter(id => !ids.has(id));
    return remaining.length === group.entityIds.length ? group : {
      ...group, entityIds: remaining, source: { ...group.source, membershipModified: true },
    };
  }).filter(group => group.entityIds.length >= 2);
}

export function groupSelection(project, ids, name, makeId) {
  const actual = project.entities.filter(entity => ids.has(entity.id)).map(entity => entity.id);
  if (actual.length < 2) throw new Error('至少选择两个图元才能建立组合');
  removeMembers(project, new Set(actual));
  const group = { id: makeId(), name: name.trim() || '新组合', entityIds: actual, source: { kind: 'manual' } };
  project.groups.push(group);
  return group;
}

export function ungroupSelection(project, ids) {
  project.groups = (project.groups || []).filter(group => !group.entityIds.some(id => ids.has(id)));
}

export function deleteSelection(project, ids) {
  ids=new Set(ids);
  const removed=(project.seamAllowances||[]).filter(recipe=>recipe.outputIds.some(id=>ids.has(id)));
  for(const recipe of removed)for(const id of recipe.outputIds)ids.add(id);
  project.seamAllowances=(project.seamAllowances||[]).filter(recipe=>!removed.includes(recipe));
  const removedNotches=(project.notches||[]).filter(recipe=>recipe.outputIds.some(id=>ids.has(id)));
  for(const recipe of removedNotches)for(const id of recipe.outputIds)ids.add(id);
  project.notches=(project.notches||[]).filter(recipe=>!removedNotches.includes(recipe));
  project.entities = project.entities.filter(entity => !ids.has(entity.id));
  removeMembers(project, ids);
}

export function duplicateSelection(project, ids, makeId, {offsetX=10,offsetY=-10}={}) {
  if(!Number.isFinite(offsetX)||!Number.isFinite(offsetY))throw new Error('复制位移无效');
  const actualIds=new Set(project.entities.filter(entity=>ids.has(entity.id)).map(entity=>entity.id));
  const gradingPlans=(project.gradingPlans||[]).filter(plan=>plan.sources.every(source=>actualIds.has(source.entityId)));
  if((project.gradingPlans||[]).length+gradingPlans.length>30)throw new Error('复制后放码方案超过 30 组上限');
  const copyableSeams=new Set((project.seamAllowances||[]).filter(recipe=>[...recipe.baseEntityIds,...recipe.outputIds].every(id=>actualIds.has(id))).map(recipe=>recipe.id));
  const copyableNotches=new Set((project.notches||[]).filter(recipe=>[recipe.baseEntityId,...recipe.outputIds].every(id=>actualIds.has(id))&&(!recipe.targetSeamId||copyableSeams.has(recipe.targetSeamId))).map(recipe=>recipe.id));
  const checks=(project.seamChecks||[]).filter(check=>[...check.a.edges,...check.b.edges].every(ref=>actualIds.has(ref.entityId))&&(check.landmarks||[]).every(mark=>[mark.a,mark.b].every(locator=>locator.kind!=='notch'||copyableNotches.has(locator.notchId))));
  if((project.seamChecks||[]).length+checks.length>100)throw new Error('复制后缝合核对超过 100 组上限');
  const idMap = new Map();
  const copies = project.entities.filter(entity => ids.has(entity.id)).map(entity => {
    const copy = JSON.parse(JSON.stringify(entity));
    copy.id = makeId(); copy.name += ' 副本';
    idMap.set(entity.id, copy.id);
    if(offsetX!==0||offsetY!==0)transform(copy, point => ({ x: point.x + offsetX, y: point.y + offsetY }));
    return copy;
  });
  const groups = (project.groups || []).filter(group => group.entityIds.every(id => ids.has(id))).map(group => ({
    ...JSON.parse(JSON.stringify(group)), id: makeId(), name: group.name + ' 副本',
    entityIds: group.entityIds.map(id => idMap.get(id)),
    contours: contoursForGroup(group).map(contour => ({ ...contour, entityIds: contour.entityIds.map(id => idMap.get(id) ?? id) })),
    source: { ...JSON.parse(JSON.stringify(group.source || {})), duplicated: true },
  }));
  project.entities.push(...copies);
  project.groups = [...(project.groups || []), ...groups];
  const recipes=(project.seamAllowances||[]).filter(recipe=>[...recipe.baseEntityIds,...recipe.outputIds].every(id=>ids.has(id)));
  const recipeMap=new Map(recipes.map(recipe=>[recipe.id,makeId()]));
  for(const copy of copies)if(copy.derivedFrom){
    if(recipeMap.has(copy.derivedFrom))copy.derivedFrom=recipeMap.get(copy.derivedFrom);
    else {delete copy.derivedFrom;delete copy.seamRole;copy.name+='（独立）';}
  }
  project.seamAllowances=[...(project.seamAllowances||[]),...recipes.map(recipe=>({...JSON.parse(JSON.stringify(recipe)),id:recipeMap.get(recipe.id),name:recipe.name+' 副本',baseEntityIds:recipe.baseEntityIds.map(id=>idMap.get(id)),edgeWidths:recipe.edgeWidths?.map(entry=>({...entry,entityId:idMap.get(entry.entityId)}))||null,outputIds:recipe.outputIds.map(id=>idMap.get(id)),signature:null,status:'stale'}))];
  const notches=(project.notches||[]).filter(recipe=>[recipe.baseEntityId,...recipe.outputIds].every(id=>ids.has(id))&&(!recipe.targetSeamId||recipeMap.has(recipe.targetSeamId)));
  const notchMap=new Map(notches.map(recipe=>[recipe.id,makeId()]));
  for(const copy of copies)if(copy.notchFrom){
    if(notchMap.has(copy.notchFrom))copy.notchFrom=notchMap.get(copy.notchFrom);
    else {delete copy.notchFrom;copy.name+='（独立）';}
  }
  project.notches=[...(project.notches||[]),...notches.map(recipe=>({...JSON.parse(JSON.stringify(recipe)),id:notchMap.get(recipe.id),name:recipe.name+' 副本',baseEntityId:idMap.get(recipe.baseEntityId),outputIds:recipe.outputIds.map(id=>idMap.get(id)),targetSeamId:recipe.targetSeamId?recipeMap.get(recipe.targetSeamId):null,signature:null,status:'stale'}))];
  project.seamChecks=[...(project.seamChecks||[]),...checks.map(check=>{
    const copy=JSON.parse(JSON.stringify(check));copy.id=makeId();copy.name+=' 副本';
    for(const side of ['a','b'])copy[side].edges=copy[side].edges.map(ref=>({...ref,entityId:idMap.get(ref.entityId)}));
    for(const mark of copy.landmarks||[])for(const side of ['a','b'])if(mark[side].kind==='notch')mark[side].notchId=notchMap.get(mark[side].notchId);
    copy.signature=null;copy.status='stale';delete copy.result;delete copy.error;return copy;
  })];
  project.gradingPlans=[...(project.gradingPlans||[]),...gradingPlans.map(plan=>{
    const copy=JSON.parse(JSON.stringify(plan));copy.id=makeId();copy.name+=' 副本';copy.sources=copy.sources.map(source=>({...source,entityId:idMap.get(source.entityId)}));copy.rules=copy.rules.map(rule=>({...rule,entityId:idMap.get(rule.entityId)}));copy.status='stale';delete copy.report;delete copy.error;return copy;
  })];
  return new Set(copies.map(entity => entity.id));
}
