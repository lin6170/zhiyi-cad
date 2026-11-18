// v74: the view keys of ET 2017 that work as modes (as ET's own menus name them and its prompts say):
//  Z 放大       box the area to enlarge, or Shift + click to enlarge around a point; the mode stays until the right button or Esc
//  C 屏幕移动   one drag moves the view, then the tool in hand is back (as in ET)
//  F7 单片全屏  click a piece and it fills the window (the page then ends the mode; V brings the whole drawing back)
// A clear layer over the drawing takes the mouse while a mode is on, so no tool underneath sees these clicks. The wheel still zooms.
const PROMPT = {
  zoom: '放大：框选要放大的区域，或按住 Shift 点一下；右键或 Esc 结束',
  pan: '屏幕移动：按住左键，拖到想看的位置',
  piece: '单片全屏：点一个裁片，让它占满窗口；右键或 Esc 结束',
};

export function createViewModes({ host, svg, view, notify = () => {} }) {
  let mode = null, press = null;
  const layer = document.createElement('div');
  layer.className = 'view-mode-layer'; layer.hidden = true;
  layer.innerHTML = '<span class="view-mode-prompt" role="status"></span><div class="view-mode-box" hidden></div>';
  host.append(layer);
  const prompt = layer.querySelector('.view-mode-prompt'), box = layer.querySelector('.view-mode-box');
  const local = event => { const r = svg.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };
  function place() {
    const r = svg.getBoundingClientRect(), h = host.getBoundingClientRect();
    Object.assign(layer.style, { left: (r.left - h.left) + 'px', top: (r.top - h.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  function end() { mode = null; press = null; layer.hidden = true; box.hidden = true; layer.dataset.mode = ''; }
  function begin(kind) {
    if (!PROMPT[kind]) return;
    mode = kind; press = null; place(); layer.dataset.mode = kind; prompt.textContent = PROMPT[kind]; box.hidden = true; layer.hidden = false;
  }
  layer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); try { layer.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer knows */ }
    press = { start: local(event), last: local(event), shift: event.shiftKey, moved: false };
    if (mode === 'pan') view.remember();
  });
  layer.addEventListener('pointermove', event => {
    if (!press) return;
    const at = local(event);
    if (Math.hypot(at.x - press.start.x, at.y - press.start.y) > 4) press.moved = true;
    if (mode === 'pan') { view.panBy(at.x - press.last.x, at.y - press.last.y); press.last = at; return; }
    if (mode === 'zoom' && press.moved) {
      Object.assign(box.style, { left: Math.min(at.x, press.start.x) + 'px', top: Math.min(at.y, press.start.y) + 'px', width: Math.abs(at.x - press.start.x) + 'px', height: Math.abs(at.y - press.start.y) + 'px' });
      box.hidden = false;
    }
    press.last = at;
  });
  layer.addEventListener('pointerup', event => {
    if (!press) return;
    const p = press, at = local(event); press = null; box.hidden = true;
    if (mode === 'pan') { if (p.moved) end(); return; }
    if (mode === 'zoom') {
      if (p.moved) { if (!view.boxToView({ x0: p.start.x, y0: p.start.y, x1: at.x, y1: at.y })) notify('框得太小了，再框大一点。'); }
      else if (p.shift || event.shiftKey) { view.remember(); view.zoomAt(2, at); }
      return;
    }
    if (mode === 'piece' && !p.moved) {
      const pieces = view.pieceAt(at);
      if (!pieces) { notify('这里没有裁片，点在裁片的线上。'); return; }
      view.remember(); view.fitEntities(pieces); end();
    }
  });
  layer.addEventListener('contextmenu', event => { event.preventDefault(); end(); });
  layer.addEventListener('wheel', event => { event.preventDefault(); view.zoomAt(Math.exp(-event.deltaY * .0015), local(event)); }, { passive: false });
  window.addEventListener('resize', () => { if (mode) place(); });
  return { begin, cancel: end, active: () => mode, prompts: PROMPT };
}
