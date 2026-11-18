/**
 * The smart pen on the canvas (v61): feeds presses, drags, right clicks and keys to the grammar in smart-pen.mjs, runs the
 * commands a finished gesture gives as one step, and shows what the pen holds. A bar over the top of the canvas carries the
 * three boxes ET's tool bar has for this tool (长度, 宽度 and, once lines are boxed, 调整量) and the status line.
 */
import { emptyPen, penStep, penHint, squared, draftLengths, penLengthText } from './smart-pen.mjs';
import { fitClampedSpline } from './fit-spline.mjs';
import { sampleCurve } from './curves.mjs';
import { sizeFromFormula, drawingSizeTable } from './size-input.mjs';

const STORE = 'zhiyi-smart-pen/v1';
/** Points along the curve that will go through the given points, for the picture of a curve that is being drawn. */
function curveThrough(points) { try { return sampleCurve({ ...fitClampedSpline(points).curve, samplingTolerance: .05 }).points; } catch { return points; } }
export function createSmartPen({ commands, host, getProject, getTool, setTool, render, notify, editPoints, isVisible = () => true }) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'smart-pen.css' }));
  let stored = {}; try { stored = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { stored = {}; }
  let unit = ['cm', 'mm', 'inch'].includes(stored.unit) ? stored.unit : 'cm', state = emptyPen(), press = null, hover = null, message = '', failed = false;
  const scale = () => (unit === 'cm' ? 10 : unit === 'inch' ? 25.4 : 1);
  const bar = Object.assign(document.createElement('section'), { id: 'smart-pen-bar', className: 'smart-pen-bar', hidden: true }); bar.setAttribute('aria-label', '智能笔');
  bar.innerHTML = '<strong>智能笔</strong><label>长度<input id="smart-length" type="text" autocomplete="off" title="可以写数，也可以像 ET 一样写尺寸表的名称和公式，如“袖长/10”（取尺寸表的纸样尺寸）"></label><label id="smart-width-label">宽度<input id="smart-width" type="text" inputmode="decimal" autocomplete="off"></label>'
    + '<label id="smart-amount-label" hidden>调整量<input id="smart-amount" type="text" inputmode="decimal" autocomplete="off"></label><select id="smart-unit" aria-label="单位"><option value="cm">cm</option><option value="mm">mm</option><option value="inch">英寸</option></select>'
    + '<label class="smart-check"><input id="smart-ortho" type="checkbox">丁字尺</label><button id="smart-finish" type="button" title="与在画布上按右键相同">结束 / 执行</button><button id="smart-cancel" type="button" title="Esc">取消</button><button id="smart-close" type="button">关闭</button>'
    + '<p id="smart-status" class="smart-status" role="status"></p>';
  host.append(bar);
  const $ = id => bar.querySelector('#' + id), active = () => getTool() === 'smart';
  $('smart-unit').value = unit;
  /** A size typed in the bar's unit, in millimetres; fractions of an inch as ET writes them (3/8, 1 3/8). Empty is 0. v71: or a
   * formula with names of the size table, as in ET's boxes (each name is the row's 纸样尺寸 in cm, a plain number is in the bar's unit). */
  let formulaError = '';
  function size(id) {
    const text = $(id).value.trim(); if (!text) return 0;
    const m = text.match(/^(-?)\s*(?:(\d+(?:\.\d+)?)|(?:(\d+)[ '-])?(\d+)\/(\d+))$/);
    if (!m) { try { return sizeFromFormula(text, unit, drawingSizeTable(getProject())).mm; } catch (error) { formulaError = error.message; return NaN; } }
    const value = m[2] !== undefined ? Number(m[2]) : (Number(m[3] || 0) + Number(m[4]) / Number(m[5]));
    return (m[1] ? -1 : 1) * value * scale();
  }
  const fields = () => ({ length: size('smart-length'), width: size('smart-width'), amount: size('smart-amount') });
  function take(result) {
    state = result.state; failed = false; message = result.message || '';
    if (result.steps) {
      try {
        const plan = commands.previewBatch({ schema: 'zhiyi-cad-batch/v1', expectedRevision: commands.read().revision, steps: result.steps, label: '智能笔：' + result.label });
        commands.apply(plan.id); message = result.label + '，可以撤销。';
        for (const key of result.used || []) $('smart-' + key).value = '';   // a length is spent by the line it made, as in ET
      } catch (error) { failed = true; message = error.message; notify(error.message); }
    }
    if (result.action?.type === 'edit-points') editPoints(result.action.entityId);
    refresh(); render();
  }
  function step(event) {
    formulaError = ''; const typed = fields(), bad = Object.entries(typed).find(([, v]) => Number.isNaN(v));
    if (bad && event.type === 'finish') { failed = true; message = '“' + { length: '长度', width: '宽度', amount: '调整量' }[bad[0]] + '”里不是一个数' + (formulaError ? '：' + formulaError : '') + '。'; refresh(); return; }
    take(penStep(state, event, getProject(), { length: typed.length || 0, width: typed.width || 0, amount: typed.amount || 0 }));
  }
  function refresh() {
    bar.hidden = !active(); if (bar.hidden) return;
    const picked = state.mode === 'picked';
    $('smart-width-label').hidden = picked; $('smart-amount-label').hidden = !picked; $('smart-ortho').checked = state.ortho;
    const status = $('smart-status'); status.textContent = message ? message + (state.mode === 'idle' ? '' : ' ' + penHint(state)) : penHint(state); status.dataset.state = failed ? 'error' : state.mode;
    bar.dataset.mode = state.mode;
  }
  $('smart-unit').onchange = () => { unit = $('smart-unit').value; try { localStorage.setItem(STORE, JSON.stringify({ unit })); } catch { /* the choice is kept for this visit only */ } refresh(); };
  $('smart-ortho').onchange = () => { state = { ...state, ortho: $('smart-ortho').checked }; refresh(); render(); };
  $('smart-finish').onclick = () => step({ type: 'finish', entityId: null });
  $('smart-cancel').onclick = () => step({ type: 'key', key: 'Escape' });
  $('smart-close').onclick = () => setTool('select');
  // In a box of the bar: Enter carries out what is in hand, as the right button does (with nothing to carry out yet it only
  // gives the keyboard back to the drawing, and the figure stays for the line to come); Esc lets go.
  bar.addEventListener('keydown', event => {
    if (event.target.tagName !== 'INPUT' || event.target.type !== 'text' || !['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.target.blur();
    if (event.key === 'Escape') { if (state.mode !== 'idle') step({ type: 'key', key: 'Escape' }); }
    else if (state.mode === 'picked' || (state.mode === 'draw' && state.points.length > 1)) step({ type: 'finish', entityId: null });
  });
  const entityOf = id => getProject().entities.find(e => e.id === id);
  // Ctrl switches the T-square, as in ET. It is taken when the key comes up without anything else having been pressed with
  // it, so that Ctrl+Z, Ctrl+S and Ctrl + click stay what they are.
  let ctrlAlone = false;
  window.addEventListener('keydown', event => { if (event.key === 'Control') { if (!event.repeat) ctrlAlone = true; } else ctrlAlone = false; }, true);
  window.addEventListener('keyup', event => {
    if (event.key !== 'Control') return; const alone = ctrlAlone; ctrlAlone = false;
    if (alone && active() && state.mode !== 'picked' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) step({ type: 'key', key: 'Control' });
  });
  return {
    begin() { state = emptyPen(); press = null; message = ''; failed = false; setTool('smart'); refresh(); },
    /** Left button down: nothing happens yet; whether this is a click or the start of a box is known when it comes up. */
    down({ point, raw, entity, event }) { ctrlAlone = false; press = { point, raw, current: raw, entityId: entity?.id || null, ctrl: Boolean(event.ctrlKey || event.metaKey), x: event.clientX, y: event.clientY, moved: false }; },
    move({ point, raw, event }) { hover = point; if (!press) return; press.current = raw; if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) press.moved = true; },
    up({ raw }) {
      const p = press; press = null; if (!p) return;
      if (p.moved && state.mode !== 'draw') step({ type: 'box', from: p.raw, to: raw, visible: isVisible });
      else step({ type: 'click', point: p.point, entityId: p.entityId, ctrl: p.ctrl });
    },
    /** Right button: ends the line being drawn, carries out what was boxed, or opens the points of the line under the pointer. */
    context({ entity }) { press = null; step({ type: 'finish', entityId: entity?.id || null }); },
    /** Keys the pen takes while it is the tool: true when the key was the pen's. */
    key(event) {
      if (!active()) return false;
      // A figure typed over the drawing goes into the bar without a click on it: into 长度, or a minus sign into 调整量 when
      // lines are boxed. The box then has the keyboard: Tab goes to the next box, Enter is the right button.
      if (!event.ctrlKey && !event.metaKey && !event.altKey && (/^[0-9.]$/.test(event.key) || (event.key === '-' && state.mode === 'picked'))) {
        const box = $(event.key === '-' ? 'smart-amount' : 'smart-length'); box.focus(); box.value += event.key; return true;
      }
      if (!['Escape', 'Enter', 'Delete', 'Backspace'].includes(event.key)) return false;
      if (state.mode === 'idle') return false;   // nothing in hand: Esc leaves the tool and Delete is the page's own, as with every tool
      step({ type: 'key', key: event.key }); return true;
    },
    /** While a point is wanted it snaps to the drawing; a box does not. */
    wantsSnap() { return active() && state.mode !== 'picked' && !press?.moved; },
    cancel() { state = emptyPen(); press = null; message = ''; failed = false; refresh(); },
    refresh() { refresh(); },
    isOpen: () => !bar.hidden, element: bar, state: () => state,
    draw({ node, overlay, screen, pathData }) {
      if (!active()) return;
      const line = (entity, attributes) => node('path', { d: pathData(entity.points, entity.closed), fill: 'none', ...attributes }, overlay);
      for (const p of state.picked) { const e = entityOf(p.id); if (!e) continue; line(e, { stroke: '#c2413a', 'stroke-width': 2.5, 'data-smart-pen': 'picked' }); if (!p.closed) { const q = screen(p.at); node('rect', { x: q.x - 5, y: q.y - 5, width: 10, height: 10, fill: '#c2413a', 'data-smart-pen': 'end' }, overlay); } }
      for (const id of state.boundaries) { const e = entityOf(id); if (e) line(e, { stroke: '#2e8b57', 'stroke-width': 2.5, 'data-smart-pen': 'boundary' }); }
      if (state.cutter) { const e = entityOf(state.cutter); if (e) line(e, { stroke: '#2e8b57', 'stroke-width': 2.5, 'stroke-dasharray': '7 4', 'data-smart-pen': 'cutter' }); }
      if (state.mode === 'draw') {
        // what a right click would draw now, with the pointer as the next point: the grammar is asked, so the picture is the result
        const last = state.points.at(-1), next = hover ? (state.ortho ? squared(last, hover) : hover) : null, typed = fields(), given = { length: typed.length || 0, width: typed.width || 0, amount: 0 };
        const ahead = next && Math.hypot(next.x - last.x, next.y - last.y) > 1e-6 ? { ...state, points: [...state.points, next] } : state, trial = ahead.points.length > 1 ? penStep(ahead, { type: 'finish', entityId: null }, getProject(), given) : null;
        for (const step of trial?.steps || []) {
          const points = step.type === 'draw.curve' ? curveThrough(step.parameters.points) : [step.parameters.from, step.parameters.to];
          node('path', { d: pathData(points, false), fill: 'none', stroke: '#dc8129', 'stroke-width': 2, 'stroke-dasharray': '5 4', 'data-smart-pen': 'draft' }, overlay);
        }
        // v72: the length of what would be drawn, as ET writes it next to the pointer (at the middle of each side for a rectangle)
        if (next) for (const label of draftLengths(trial?.steps, state.ortho)) {
          const pointer = label.at === 'pointer', q = screen(pointer ? next : label.at);
          node('text', { x: q.x + (pointer ? 10 : 3), y: q.y - (pointer ? 10 : 4), fill: '#2e8b57', 'font-size': 13, 'font-weight': 600, 'data-smart-pen': 'length' }, overlay).textContent = penLengthText(label.lengthMm, unit);
        }
        for (const p of state.points) { const q = screen(p); node('circle', { cx: q.x, cy: q.y, r: 3.5, fill: '#dc8129', 'data-smart-pen': 'point' }, overlay); }
      }
      if (press?.moved && state.mode !== 'draw') { const a = screen(press.raw), b = screen(press.current); node('rect', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y), fill: '#2f6fb022', stroke: '#2f6fb0', 'stroke-dasharray': '4 3', 'data-smart-pen': 'box' }, overlay); }
    },
  };
}
