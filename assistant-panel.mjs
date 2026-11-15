/**
 * The assistant panel: a conversation beside the canvas. An instruction becomes a plan,
 * the plan is previewed in the panel, and only "应用到画布" changes the drawing.
 * All text from the user, a planner or a service is written with textContent.
 */
import { createAssistant } from './assistant-core.mjs';
import { localPlanner, EXAMPLES } from './assistant-local.mjs';
import { createRemotePlanner, checkServiceUrl } from './assistant-remote.mjs';
import { bounds } from './geometry.mjs';

const STORE = 'zhiyi-assistant/v1', ACCESS = 'zhiyi-assistant/access', SVG = 'http://www.w3.org/2000/svg';
const cm = mm => String(Math.round(mm * 100) / 1000);
const YES = /^(应用|应用到画布|确认|确定|好|好的|可以|行|对|是|是的|ok|yes)[。.!！]*$/i, NO = /^(放弃|取消|不要|不用|算了|不|不行|no)[。.!！]*$/i;
function load() { try { const value = JSON.parse(localStorage.getItem(STORE)); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function save(value) { try { localStorage.setItem(STORE, JSON.stringify(value)); } catch { /* private mode: settings last for this visit only */ } }
function element(tag, properties = {}, children = []) { const node = Object.assign(document.createElement(tag), properties); node.append(...children); return node; }

/** One line of detail for a previewed step, in centimetres. */
function stepDetail(step) {
  const s = step.summary || {};
  if (step.type === 'draw.rectangle') return cm(s.widthMm) + ' × ' + cm(s.heightMm) + ' cm';
  if (s.lengthMm !== undefined) return '长 ' + cm(s.lengthMm) + ' cm';
  if (step.type === 'piece.create') return '轮廓 ' + s.contourEdges + ' 条线，自动加布纹线';
  if (step.type === 'seam.apply') return '缝份 ' + s.widthsMm.map(cm).join(' / ') + ' cm';
  if (step.type === 'pattern.updateDraft') return s.changed.length ? s.changed.map(c => c.name + ' ' + (c.field.endsWith('Share') ? c.before + '% → ' + c.after + '%' : cm(c.before) + ' → ' + cm(c.after) + ' cm')).join('，') : '按记录的尺寸重新生成';
  if (step.type === 'pattern.draftStraightPants') return '前裤片、后裤片，含省、定位线、布纹线和缝份';
  if (step.type === 'piece.move' || step.type === 'selection.move') return (s.dx ? '向' + (s.dx > 0 ? '右 ' : '左 ') + cm(Math.abs(s.dx)) + ' cm ' : '') + (s.dy ? '向' + (s.dy > 0 ? '上 ' : '下 ') + cm(Math.abs(s.dy)) + ' cm' : '');
  if (s.degrees !== undefined) return (s.degrees < 0 ? '顺时针 ' : '逆时针 ') + Math.abs(s.degrees) + ' 度';
  if (s.removed !== undefined) return '删除 ' + s.removed + ' 个图元';
  return '';
}

export function createAssistantPanel({ commands, host, getSelection = () => [], hostActions = {}, prepare = () => {}, onApplied = () => {} }) {
  const css = element('link', { rel: 'stylesheet', href: 'assistant.css' }); document.head.append(css);
  let settings = { planner: 'local', serviceUrl: '', preferences: {}, ...load() }, accessCode = '', greeted = false;
  if (!['local', 'remote'].includes(settings.planner)) settings.planner = 'local';
  try { accessCode = sessionStorage.getItem(ACCESS) || ''; } catch { accessCode = ''; }
  const remote = createRemotePlanner({ getSettings: () => ({ serviceUrl: settings.serviceUrl, accessCode }) });
  const assistant = createAssistant({ commands, planners: { local: localPlanner, remote }, hostActions, getSelection,
    preferences: { get: () => settings.preferences || {}, set: patch => { settings = { ...settings, preferences: { ...settings.preferences, ...patch } }; save(settings); } } });

  const panel = element('aside', { id: 'assistant-panel', className: 'assistant-panel', hidden: true }); panel.setAttribute('aria-label', '制版助手');
  panel.innerHTML = '<header><div class="assistant-heading"><strong>制版助手</strong><span id="assistant-mode" class="assistant-mode"></span></div><div class="assistant-header-actions"><button id="assistant-settings-toggle" type="button" aria-expanded="false" aria-controls="assistant-settings">设置</button><button id="assistant-close" type="button">关闭</button></div></header>' +
    '<section id="assistant-settings" class="assistant-settings" hidden><p class="assistant-settings-title">怎样理解你的话</p>' +
    '<label class="assistant-radio"><input type="radio" name="assistant-planner" value="local"><span><strong>本机指令</strong>不联网，只认识固定的说法。</span></label>' +
    '<label class="assistant-radio"><input type="radio" name="assistant-planner" value="remote"><span><strong>模型服务</strong>把指令交给你配置的服务，由大模型规划画图步骤。</span></label>' +
    '<div id="assistant-remote-fields"><label>服务地址<input id="assistant-service-url" type="url" placeholder="https://…" autocomplete="off" spellcheck="false"></label><label>访问码（可选，只在本次浏览器会话内保留）<input id="assistant-access-code" type="password" autocomplete="off"></label>' +
    '<p class="assistant-note">启用后，你输入的文字，以及画布上裁片和线条的名称、尺寸，会发送到这个服务。模型密钥只放在服务端，本页面不保存。</p></div>' +
    '<div class="assistant-settings-actions"><button id="assistant-settings-save" type="button" class="primary">保存设置</button><span id="assistant-settings-status" role="status"></span></div></section>' +
    '<div id="assistant-log" class="assistant-log" role="log" aria-live="polite" tabindex="0"></div>' +
    '<section id="assistant-proposal" class="assistant-proposal" hidden><div class="assistant-proposal-title"><strong>计划预演</strong><span id="assistant-counts"></span></div><svg id="assistant-preview" role="img" aria-label="计划预演图：绿色为新增或修改后的线，红色虚线为将被替换或删除的线"></svg>' +
    '<ol id="assistant-steps"></ol><table id="assistant-measures" hidden><thead><tr><th>核对项</th><th>目标</th><th>实际</th></tr></thead><tbody></tbody></table>' +
    '<div class="assistant-proposal-actions"><button id="assistant-apply" type="button" class="primary">应用到画布</button><button id="assistant-discard" type="button">放弃</button><span>画布尚未改动 · 也可回复“好”或“算了”</span></div></section>' +
    '<div id="assistant-choices" class="assistant-choices"></div>' +
    '<form id="assistant-form"><textarea id="assistant-input" rows="2" maxlength="2000" placeholder="例如：画一条直筒裤，腰围76 臀围96 裤长102" aria-label="给助手的指令"></textarea><div class="assistant-form-actions"><button id="assistant-undo" type="button">撤销上一步</button><button id="assistant-send" type="submit" class="primary">发送</button></div></form>';
  host.append(panel);
  const $ = id => panel.querySelector('#' + id), log = $('assistant-log');

  function bubble(role, text, { notes = [], error = '' } = {}) {
    const box = element('div', { className: 'assistant-message ' + role });
    if (text) box.append(element('p', { textContent: text }));
    if (error) box.append(element('p', { className: 'assistant-error', textContent: error }));
    if (notes.length) box.append(element('ul', { className: 'assistant-notes' }, notes.map(note => element('li', { textContent: note }))));
    log.append(box); while (log.children.length > 200) log.firstElementChild.remove(); log.scrollTop = log.scrollHeight; return box;
  }
  function choices(list = []) {
    $('assistant-choices').replaceChildren(...list.map(choice => { const button = element('button', { type: 'button', className: 'assistant-choice', textContent: choice.label, title: choice.send }); button.onclick = () => send(choice.send); return button; }));
  }
  function mode() { $('assistant-mode').textContent = settings.planner === 'remote' ? '模型服务' : '本机指令'; $('assistant-mode').dataset.planner = settings.planner; }
  function busy(value) { for (const id of ['assistant-send', 'assistant-apply', 'assistant-discard', 'assistant-undo']) $(id).disabled = value; panel.dataset.busy = String(value); }

  function path(entity) { const points = entity.points; return 'M' + points.map(p => p.x + ' ' + -p.y).join('L') + (entity.closed ? 'Z' : ''); }
  function drawPreview(preview) {
    const svg = $('assistant-preview'), after = preview.changes.map(c => c.after), gone = [...preview.removed.map(r => r.before), ...preview.changes.filter(c => c.before).map(c => c.before)];
    const box = bounds([...after, ...gone]); svg.replaceChildren(); svg.hidden = !box; if (!box) return;
    const pad = Math.max(box.width, box.height, 10) * .06, touched = new Set([...preview.changes.map(c => c.id), ...preview.removed.map(r => r.id)]);
    svg.setAttribute('viewBox', [box.minX - pad, -box.maxY - pad, box.width + 2 * pad, box.height + 2 * pad].join(' '));
    const inside = e => { const b = bounds([e]); return b && b.maxX >= box.minX - pad && b.minX <= box.maxX + pad && b.maxY >= box.minY - pad && b.minY <= box.maxY + pad; };
    const context = commands.readProject().entities.filter(e => !touched.has(e.id) && e.type !== 'text').slice(0, 4000).filter(inside);
    const add = (entity, kind) => {
      if (entity.type === 'text') { if (kind !== 'new') return; const t = document.createElementNS(SVG, 'text'); t.setAttribute('x', entity.points[0].x); t.setAttribute('y', -entity.points[0].y); t.setAttribute('font-size', entity.height); t.setAttribute('class', 'assistant-preview-text'); t.textContent = entity.text; svg.append(t); return; }
      const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', path(entity)); p.setAttribute('class', 'assistant-preview-' + kind + (entity.derivedFrom ? ' seam' : '') + (entity.layer === 'internal' || entity.layer === 'grain' ? ' inner' : '')); svg.append(p);
    };
    for (const entity of context) add(entity, 'context');
    for (const entity of gone) add(entity, 'old');
    for (const entity of after) add(entity, 'new');
  }
  function showProposal(result) {
    $('assistant-counts').textContent = '新增 ' + result.counts.added + ' · 修改 ' + result.counts.changed + ' · 删除 ' + result.counts.removed;
    $('assistant-steps').replaceChildren(...result.steps.map(step => element('li', {}, [element('strong', { textContent: step.title }), element('span', { textContent: stepDetail(step) })])));
    const measures = result.steps.flatMap(step => step.measurements || []).filter(m => Number.isFinite(m.target) && Number.isFinite(m.actual)).slice(-12), body = $('assistant-measures').tBodies[0];
    body.replaceChildren(...measures.map(m => element('tr', {}, [element('td', { textContent: m.name }), element('td', { textContent: cm(m.target) }), element('td', { textContent: cm(m.actual) })])));
    $('assistant-measures').hidden = !measures.length;
    drawPreview(result.preview); $('assistant-proposal').hidden = false; log.scrollTop = log.scrollHeight; // the card takes room from the conversation
  }
  function hideProposal() { $('assistant-proposal').hidden = true; $('assistant-preview').replaceChildren(); }
  const actionNotes = actions => (actions || []).filter(a => a.message).map(a => a.message);

  async function send(text) {
    const instruction = String(text ?? '').trim(); if (!instruction || assistant.isBusy()) return;
    // A short yes or no answers the plan that is waiting. The Apply button never takes the focus, so a repeated Enter cannot confirm by accident.
    const yes = YES.test(instruction), no = NO.test(instruction);
    if (yes || no) { bubble('user', instruction); $('assistant-input').value = ''; if (!assistant.hasPending()) bubble('assistant', '现在没有等待确认的计划。'); else if (yes) applyPending(); else discardPending(); return; }
    prepare(); hideProposal(); choices(); bubble('user', instruction); $('assistant-input').value = ''; busy(true);
    const waiting = settings.planner === 'remote' ? bubble('assistant waiting', '正在请模型服务规划…') : null;
    let result;
    try { result = await assistant.ask(instruction, { planner: settings.planner }); }
    catch (error) { result = { kind: 'error', reply: '', error: error.message, assumptions: [], choices: [] }; }
    waiting?.remove(); busy(false);
    if (result.kind === 'reply') bubble('assistant', result.reply, { notes: [...result.assumptions, ...actionNotes(result.actions)] });
    else if (result.kind === 'proposal') { bubble('assistant', result.reply, { notes: result.assumptions }); showProposal(result); }
    else bubble('assistant', result.reply, { notes: result.assumptions || [], error: (result.reply ? '预演没有通过，画布没有改动：' : '') + result.error });
    choices(result.kind === 'proposal' ? [] : result.choices);
    $('assistant-input').focus({ preventScroll: true });
    if (result.kind === 'reply' && result.actions?.length) onApplied(result);
  }
  $('assistant-form').onsubmit = event => { event.preventDefault(); send($('assistant-input').value); };
  $('assistant-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); send($('assistant-input').value); } });
  function applyPending() {
    if (!assistant.hasPending()) { hideProposal(); return; }
    prepare(); const result = assistant.apply(); hideProposal();
    if (result.kind === 'applied') { bubble('assistant', '已应用到画布。不满意可以点“撤销上一步”。', { notes: actionNotes(result.actions) }); choices(result.choices); onApplied(result); }
    else { bubble('assistant', '', { error: result.error }); choices(); }
    $('assistant-input').focus({ preventScroll: true });
  }
  $('assistant-apply').onclick = applyPending;
  function discardPending() { assistant.discard(); hideProposal(); bubble('assistant', '已放弃这份计划，画布没有改动。'); $('assistant-input').focus({ preventScroll: true }); }
  $('assistant-discard').onclick = discardPending;
  $('assistant-undo').onclick = () => { assistant.discard(); hideProposal(); prepare(); const result = assistant.runAction('history.undo'); bubble('assistant', result.ok ? '已撤销上一步。' : '', { error: result.ok ? '' : result.message }); if (result.ok) onApplied(result); };

  function fillSettings() {
    for (const radio of panel.querySelectorAll('input[name=assistant-planner]')) radio.checked = radio.value === settings.planner;
    $('assistant-service-url').value = settings.serviceUrl || ''; $('assistant-access-code').value = accessCode; $('assistant-remote-fields').hidden = settings.planner !== 'remote'; $('assistant-settings-status').textContent = '';
  }
  for (const radio of panel.querySelectorAll('input[name=assistant-planner]')) radio.onchange = () => { $('assistant-remote-fields').hidden = radio.value !== 'remote' || !radio.checked; };
  $('assistant-settings-toggle').onclick = () => { const open = $('assistant-settings').hidden; if (open) fillSettings(); $('assistant-settings').hidden = !open; $('assistant-settings-toggle').setAttribute('aria-expanded', String(open)); };
  $('assistant-settings-save').onclick = () => {
    const planner = panel.querySelector('input[name=assistant-planner]:checked')?.value || 'local', status = $('assistant-settings-status'); let serviceUrl = $('assistant-service-url').value.trim();
    try { if (planner === 'remote') serviceUrl = checkServiceUrl(serviceUrl); else if (serviceUrl) serviceUrl = checkServiceUrl(serviceUrl); }
    catch (error) { status.textContent = error.message; status.dataset.error = 'true'; return; }
    assistant.discard(); hideProposal();
    settings = { ...settings, planner, serviceUrl }; accessCode = $('assistant-access-code').value; save(settings);
    try { accessCode ? sessionStorage.setItem(ACCESS, accessCode) : sessionStorage.removeItem(ACCESS); } catch { /* kept in memory only */ }
    status.textContent = '已保存。'; delete status.dataset.error; mode();
    bubble('assistant', planner === 'remote' ? '已改用模型服务。之后的指令会发送到 ' + serviceUrl + '。' : '已改用本机指令，不会向外发送任何内容。');
  };
  function open() {
    panel.hidden = false; mode();
    if (!greeted) { greeted = true; bubble('assistant', '说一句话，我来画。我先给出计划和预演，你确认后才改动画布，随时可以撤销。没写单位的数字按厘米理解。'); choices([...EXAMPLES.slice(0, 2), { label: '能做什么', send: '帮助' }]); }
    $('assistant-input').focus({ preventScroll: true });
  }
  function close() { panel.hidden = true; }
  $('assistant-close').onclick = close;
  // A newly opened file is a different drawing: drop the waiting plan and what "它" referred to, keep the conversation.
  const reset = () => { assistant.forget(); hideProposal(); choices(); };
  return Object.freeze({ open, close, reset, toggle: () => (panel.hidden ? open() : close()), isOpen: () => !panel.hidden, send, assistant, element: panel });
}
