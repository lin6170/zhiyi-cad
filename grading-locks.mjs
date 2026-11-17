/**
 * ET 2017's locks of grading mode (v69), as ET's own saves showed them:
 *   - 锁定放码点: the chosen points keep their place in the sizes they are locked in; 推板展开 no longer moves them by their rules.
 *     ET locks a point in every size shown except the base size (it never locks a point of the base size). Its file marks such a
 *     point with bit 0x08 of the node's flag byte, in that size's layer.
 *   - 解锁放码点: the lock goes; at the next expansion the point follows its rule again.
 *   - 锁定解锁当前层: the whole size is kept as it is (bit 0x08 of the layer's flag byte); a second time unlocks it.
 *   - An edit made in one size (ET's 端移动 with that size as the current layer) moves the point in that size only and locks every
 *     end of each line whose shape changed.
 * A lock remembers the station (line and point number, and where the point stands in the base drawing, so that it is found again
 * after the line is edited) and its place in that size. A whole size kept as it is locks every station of every graded line there.
 */
import { stationsOf } from './grading-table.mjs';

export const SAME_MM = .5;   // points this close to the place asked for are the points there (ET's box around a corner)
const clone = value => JSON.parse(JSON.stringify(value));
const round = v => Math.round(v * 1e6) / 1e6;

/** The stations of the graded lines that stand on a place of the base drawing (all lines meeting at a corner). */
export function stationsAtPlace(project, plan, at, reach = SAME_MM) {
  const sources = new Set(plan.sources.map(source => source.entityId)), out = [];
  for (const entity of project.entities) {
    if (!sources.has(entity.id) || entity.type === 'text' || entity.derivedFrom || entity.notchFrom) continue;
    const stations = stationsOf(entity); if (!stations) continue;
    stations.points.forEach((p, index) => { if (Math.hypot(p.x - at.x, p.y - at.y) <= reach) out.push({ entityId: entity.id, index, at: { x: p.x, y: p.y }, stations: stations.points.length }); });
  }
  return out;
}

/** The locks of one size, as places to put stations on: Map 'entityId#index' -> { x, y }. */
export function locksOfSize(plan, sizeId) {
  const out = new Map();
  for (const lock of plan.locks || []) if (lock.sizeId === sizeId) out.set(lock.entityId + '#' + lock.index, { x: lock.x, y: lock.y });
  return out;
}

const keyOf = lock => lock.entityId + '#' + lock.index + '@' + lock.sizeId;
function putLock(value, station, sizeId, place, layer = false) {
  value.locks = (value.locks || []).filter(lock => !(lock.entityId === station.entityId && lock.index === station.index && lock.sizeId === sizeId && Boolean(lock.layer) === layer));
  value.locks.push({ entityId: station.entityId, index: station.index, at: { x: station.at.x, y: station.at.y }, stations: station.stations, sizeId, x: round(place.x), y: round(place.y), ...(layer ? { layer: true } : {}) });
}
const sizedPoint = (result, station) => { const entity = result.project.entities.find(item => item.id === station.entityId); if (!entity) throw new Error('尺码“' + result.size.label + '”里缺少这条线'); return stationsOf(entity).points[station.index]; };

/** 锁定放码点: locks the points on a place in the sizes named (their present places there). `generate(sizeId)` makes one size. */
export function lockPoints(project, plan, at, sizeIds, generate) {
  const stations = stationsAtPlace(project, plan, at);
  if (!stations.length) throw new Error('这个位置上没有放码方案里的线的端点或放码点（离它 ' + SAME_MM + ' mm 以内）。');
  const value = clone(plan); let locked = 0;
  for (const sizeId of sizeIds) { const result = generate(sizeId); for (const station of stations) { putLock(value, station, sizeId, sizedPoint(result, station)); locked++; } }
  return { value, stations, locked };
}

/** 解锁放码点: the point locks on a place go in the sizes named (a size kept as a whole stays kept). */
export function unlockPoints(project, plan, at, sizeIds) {
  const stations = stationsAtPlace(project, plan, at), keys = new Set();
  for (const station of stations) for (const sizeId of sizeIds) keys.add(station.entityId + '#' + station.index + '@' + sizeId);
  const value = clone(plan), before = (value.locks || []).length;
  value.locks = (value.locks || []).filter(lock => lock.layer || !keys.has(keyOf(lock)));
  return { value, stations, unlocked: before - value.locks.length };
}

/** 锁定解锁当前层: keeps one size as it is now (every station of every graded line locked there), or lets it follow the rules again. */
export function lockSize(project, plan, sizeId, locked, generate) {
  const value = clone(plan);
  value.locks = (value.locks || []).filter(lock => !(lock.layer && lock.sizeId === sizeId));
  value.lockedSizes = (value.lockedSizes || []).filter(id => id !== sizeId);
  if (!locked) return { value, stations: 0 };
  const result = generate(sizeId), sources = new Set(plan.sources.map(source => source.entityId)); let count = 0;
  for (const entity of project.entities) {
    if (!sources.has(entity.id) || entity.type === 'text' || entity.derivedFrom || entity.notchFrom) continue;
    const stations = stationsOf(entity); if (!stations) continue;
    stations.points.forEach((p, index) => { const station = { entityId: entity.id, index, at: p, stations: stations.points.length }; putLock(value, station, sizeId, sizedPoint(result, station), true); count++; });
  }
  value.lockedSizes.push(sizeId);
  return { value, stations: count };
}

/** ET's 端移动 in one size: the points on a place go to `to` in that size, and every end of the lines through them is locked. */
export function moveInSize(project, plan, sizeId, at, to, generate) {
  const stations = stationsAtPlace(project, plan, at);
  if (!stations.length) throw new Error('这个位置上没有放码方案里的线的端点或放码点（离它 ' + SAME_MM + ' mm 以内）。');
  const value = clone(plan), result = generate(sizeId), ends = [];
  for (const station of stations) {
    putLock(value, station, sizeId, to);
    const entity = project.entities.find(item => item.id === station.entityId), last = stationsOf(entity).points.length - 1;
    // ET locks both ends of every line whose shape the move changed (the far end where it stands now): a curve changes as a whole, a
    // straight line or a part of a polyline between two corners is one of ET's lines (a closed polyline goes round)
    const around = entity.curve || last === 1 ? [0, last] : [station.index - 1, station.index + 1].map(i => entity.closed ? (i + last + 1) % (last + 1) : i).filter(i => i >= 0 && i <= last);
    for (const index of around) {
      if (index === station.index || stations.some(other => other.entityId === station.entityId && other.index === index)) continue;
      const end = { entityId: station.entityId, index, at: stationsOf(entity).points[index], stations: last + 1 };
      if (!(value.locks || []).some(lock => !lock.layer && lock.entityId === end.entityId && lock.index === end.index && lock.sizeId === sizeId)) { putLock(value, end, sizeId, sizedPoint(result, end)); ends.push(end); }
    }
  }
  return { value, stations, ends };
}

/** What the scene and the panel say about the locks of a plan. */
export function describeLocks(plan) {
  const label = id => (plan.sizes.find(size => size.id === id) || {}).label || id, points = new Map();
  for (const lock of plan.locks || []) if (!lock.layer) { const key = label(lock.sizeId); points.set(key, (points.get(key) || 0) + 1); }
  return { lockedPoints: [...points].map(([size, count]) => ({ size, points: count })), lockedSizes: (plan.lockedSizes || []).map(label) };
}
