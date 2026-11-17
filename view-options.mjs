/**
 * Display switches: which kinds of lines are drawn, which pieces are hidden, and the labels
 * and fills that can be laid over the drawing. All of this is how the drawing is looked at;
 * none of it is stored in the drawing or written to a file.
 */
import { contoursForGroup } from './topology.mjs';
import { pieceOutline } from './piece-info.mjs';
import { length as entityLength } from './geometry.mjs';

export const VIEW_SWITCHES = [['net', '净边线'], ['seam', '缝边线'], ['notch', '刀口'], ['auxiliary', '辅助线'], ['fill', '填充显示'], ['lengths', '线的长度'], ['seamWidths', '缝边宽度'], ['axes', '坐标轴'], ['toolbar', '工具条'], ['statusbar', '状态条']];
export const VIEW_DEFAULTS = Object.freeze({ net: true, seam: true, notch: true, auxiliary: true, fill: false, lengths: false, seamWidths: false, axes: false, toolbar: true, statusbar: true });
const STORE = 'zhiyi-view/v1';
const cm = mm => String(Math.round(mm) / 10);

/** What each entity is for the switches: text, seam (seam line), notch, auxiliary, net (outline edge of a piece) or other. */
export function classify(project) {
  const kinds = new Map(), owner = new Map(), net = new Set();
  for (const group of project.groups || []) {
    for (const id of group.entityIds) owner.set(id, group);
    for (const id of contoursForGroup(group).find(c => c.role === 'primary-contour')?.entityIds || []) net.add(id);
  }
  for (const entity of project.entities) kinds.set(entity.id, entity.type === 'text' ? 'text' : entity.derivedFrom ? 'seam' : entity.notchFrom ? 'notch' : entity.aux ? 'auxiliary' : net.has(entity.id) ? 'net' : 'other');
  return { kinds, owner };
}

/**
 * What is seen and what can be picked with the drawing as it is now.
 * visible(entity): drawn. pickable(entity, forCommand): can be clicked; a locked piece only by the command tools, which refuse to change it.
 */
export function viewOf(project, options, hiddenPieces) {
  const { kinds, owner } = classify(project);
  const visible = entity => { const group = owner.get(entity.id); if (group && hiddenPieces.has(group.id)) return false; const kind = kinds.get(entity.id); return options[kind] !== false; };
  const locked = entity => Boolean(owner.get(entity.id)?.locked);
  return { visible, locked, pickable: (entity, forCommand = false) => visible(entity) && (forCommand || !locked(entity)), kind: entity => kinds.get(entity.id), piece: entity => owner.get(entity.id) || null };
}

/** The point half way along a line, on its displayed points. */
function middleOf(entity) {
  const points = entity.closed ? [...entity.points, entity.points[0]] : entity.points; let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) { const a = points[i - 1], b = points[i], span = Math.hypot(b.x - a.x, b.y - a.y); if (span >= left && span > 0) { const t = left / span; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; } left -= span; }
  return { ...points[0] };
}

/** One label per visible line with its length in centimetres. Seam lines, notches and texts carry none. */
export function lengthLabels(project, view) {
  const labels = [];
  for (const entity of project.entities) {
    if (entity.type === 'text' || entity.derivedFrom || entity.notchFrom || entity.mark || !view.visible(entity)) continue;
    const total = entityLength(entity); if (!(total > 0)) continue;
    labels.push({ at: middleOf(entity), text: cm(total), entityId: entity.id });
  }
  return labels;
}

/** One label per edge of every seam allowance with its width in centimetres, at the middle of the net edge it belongs to. */
export function seamWidthLabels(project, view) {
  const byId = new Map(project.entities.map(e => [e.id, e])), labels = [];
  for (const recipe of project.seamAllowances || []) {
    const edges = recipe.widthMode === 'edges' ? recipe.edgeWidths.map(w => ({ entityId: w.entityId, segmentIndex: w.segmentIndex, width: w.width })) : recipe.baseEntityIds.map(id => ({ entityId: id, width: Math.abs(recipe.distance) }));
    for (const edge of edges) {
      const entity = byId.get(edge.entityId); if (!entity || !view.visible(entity)) continue;
      let at;
      if (Number.isInteger(edge.segmentIndex) && entity.closed && !entity.curve) { const a = entity.points[edge.segmentIndex], b = entity.points[(edge.segmentIndex + 1) % entity.points.length]; if (!a || !b) continue; at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
      else at = middleOf(entity);
      labels.push({ at, text: cm(edge.width), entityId: entity.id, ...(Number.isInteger(edge.segmentIndex) ? { segmentIndex: edge.segmentIndex } : {}) });
    }
  }
  return labels;
}

/** The outline to fill for every piece that is not hidden: the cut line when the piece has a seam allowance that is shown, otherwise the net line. */
export function pieceFills(project, options, hiddenPieces) {
  const fills = [];
  for (const group of project.groups || []) {
    if (hiddenPieces.has(group.id)) continue;
    const contour = contoursForGroup(group).find(c => c.role === 'primary-contour'), recipe = contour && (project.seamAllowances || []).find(r => r.baseEntityIds.length === contour.entityIds.length && r.baseEntityIds.every(id => contour.entityIds.includes(id)));
    let points = null;
    if (recipe && options.seam !== false) { const loops = (recipe.outputIds || []).map(id => project.entities.find(e => e.id === id)).filter(e => e && e.closed && e.points.length >= 3); if (loops.length) points = loops.reduce((a, b) => Math.abs(area(b.points)) > Math.abs(area(a.points)) ? b : a).points; }
    if (!points) points = pieceOutline(project, group);
    if (points) fills.push({ groupId: group.id, locked: Boolean(group.locked), points });
  }
  return fills;
}
function area(points) { let sum = 0; for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += a.x * b.y - b.x * a.y; } return sum / 2; }

/**
 * The "显示" menu in the command bar and the state behind it.
 * host: the element the menu is appended to. getSelection(): ids of the selected entities. onChange(): redraw.
 */
export function createViewMenu({ host, getProject, getSelection, onChange, notify = () => {} }) {
  let stored = {}; try { stored = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { stored = {}; }
  const options = { ...VIEW_DEFAULTS }; for (const [key] of VIEW_SWITCHES) if (typeof stored[key] === 'boolean') options[key] = stored[key];
  const hiddenPieces = new Set();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(options)); } catch { /* kept for this visit only */ } };
  const menu = document.createElement('details'); menu.className = 'view-menu'; menu.id = 'view-menu';
  menu.innerHTML = '<summary title="选择画布上显示哪些内容">显示</summary><div class="view-menu-body"><div id="view-switches"></div><div class="view-menu-actions"><button id="view-hide-pieces" type="button">隐藏选中的裁片</button><button id="view-show-pieces" type="button">显示全部裁片</button></div><p id="view-hidden-note" class="view-hidden-note" hidden></p></div>';
  host.append(menu);
  const $ = id => menu.querySelector('#' + id);
  for (const [key, label] of VIEW_SWITCHES) {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'view-' + key, checked: options[key] }), row = document.createElement('label');
    row.append(box, ' ' + label); box.onchange = () => { options[key] = box.checked; save(); refresh(); onChange(); };
    $('view-switches').append(row);
  }
  function refresh() {
    const groups = new Set((getProject().groups || []).map(g => g.id)); for (const id of [...hiddenPieces]) if (!groups.has(id)) hiddenPieces.delete(id);
    const note = $('view-hidden-note'); note.hidden = !hiddenPieces.size; note.textContent = hiddenPieces.size ? '有 ' + hiddenPieces.size + ' 个裁片被隐藏。' : '';
    menu.classList.toggle('view-menu-changed', hiddenPieces.size > 0 || VIEW_SWITCHES.some(([key]) => ['net', 'seam', 'notch', 'auxiliary'].includes(key) && !options[key]));
  }
  $('view-hide-pieces').onclick = () => {
    const chosen = new Set(getSelection()), pieces = (getProject().groups || []).filter(group => group.entityIds.some(id => chosen.has(id)));
    if (!pieces.length) { notify('请先在画布上选中要隐藏的裁片。'); return; }
    for (const piece of pieces) hiddenPieces.add(piece.id);
    refresh(); onChange({ hidden: pieces.map(p => p.id) });
  };
  $('view-show-pieces').onclick = () => { hiddenPieces.clear(); refresh(); onChange(); };
  // The command bar scrolls sideways and would cut the list off, so the list is placed on the window under its button.
  menu.addEventListener('toggle', () => { if (!menu.open) return; const box = menu.getBoundingClientRect(), body = menu.querySelector('.view-menu-body'); body.style.left = Math.max(4, Math.min(box.left, window.innerWidth - 236)) + 'px'; body.style.top = (box.bottom + 4) + 'px'; });
  // clicking elsewhere closes the menu
  document.addEventListener('pointerdown', event => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
  refresh();
  return { options, hiddenPieces, element: menu, refresh,
    set(key, value) { if (!(key in VIEW_DEFAULTS)) throw new Error('没有这个显示开关。'); options[key] = Boolean(value); $('view-' + key).checked = options[key]; save(); refresh(); onChange(); },
    hide(ids) { for (const id of ids) hiddenPieces.add(id); refresh(); onChange(); }, show(ids) { if (ids) for (const id of ids) hiddenPieces.delete(id); else hiddenPieces.clear(); refresh(); onChange(); },
    view: () => viewOf(getProject(), options, hiddenPieces) };
}
