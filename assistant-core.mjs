/**
 * The assistant's working loop: instruction → plan → staged preview → apply or discard.
 * A planner (the offline parser or a model service) only proposes commands of the shared
 * command set. Nothing touches the project until the user applies the preview, and a
 * whole plan is one undo step.
 */
import { PLAN_SCHEMA } from './assistant-local.mjs';

export const ASSISTANT_ACTIONS = Object.freeze(['history.undo', 'history.redo', 'view.fit', 'file.savePrj', 'file.exportDxf', 'file.saveProject']);
const copy = value => JSON.parse(JSON.stringify(value));
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const controlFree = value => ![...value].some(c => { const code = c.codePointAt(0); return code < 32 && code !== 10; });

/** Check a plan from any planner and return a copy holding only the fields the assistant uses. */
export function validatePlan(plan, catalog) {
  const fail = message => { throw new Error('计划格式无效：' + message); };
  if (!isObject(plan) || plan.schema !== PLAN_SCHEMA) fail('版本不受支持。');
  if (!text(plan.reply, 4000) || !plan.reply.trim() || !controlFree(plan.reply)) fail('缺少说明文字。');
  const types = new Set(catalog.commands.map(c => c.type)), names = new Set();
  const list = (value, max, name) => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > max) fail(name + '过多或不是列表。'); return value; };
  const steps = list(plan.steps, 200, '步骤').map((step, index) => {
    if (!isObject(step) || Object.keys(step).some(key => !['type', 'parameters', 'as'].includes(key))) fail('第 ' + (index + 1) + ' 步含未定义的字段。');
    if (!types.has(step.type)) fail('第 ' + (index + 1) + ' 步使用了命令目录以外的命令“' + String(step.type).slice(0, 60) + '”。');
    if (!isObject(step.parameters)) fail('第 ' + (index + 1) + ' 步缺少参数。');
    if (step.as !== undefined && (typeof step.as !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(step.as) || names.has(step.as))) fail('第 ' + (index + 1) + ' 步的名称无效或重复。');
    if (step.as) names.add(step.as);
    return { type: step.type, parameters: copy(step.parameters), ...(step.as ? { as: step.as } : {}) };
  });
  const actions = list(plan.actions, 5, '动作').map(action => { if (!isObject(action) || !ASSISTANT_ACTIONS.includes(action.id)) fail('含未定义的动作。'); return { id: action.id }; });
  const strings = (value, name) => list(value, 20, name).map(item => { if (!text(item, 600) || !controlFree(item)) fail(name + '须为短文字。'); return item; });
  const choices = list(plan.choices, 8, '选项').map(choice => { if (!isObject(choice) || !text(choice.label, 40) || !choice.label || !text(choice.send, 500) || !choice.send || !controlFree(choice.label + choice.send)) fail('选项无效。'); return { label: choice.label, send: choice.send }; });
  const result = { schema: PLAN_SCHEMA, reply: plan.reply, steps, actions, assumptions: strings(plan.assumptions, '假设'), questions: strings(plan.questions, '问题'), choices };
  if (plan.remember !== undefined) { if (!isObject(plan.remember) || Object.keys(plan.remember).some(key => key !== 'measureBasis') || !['garment', 'body'].includes(plan.remember.measureBasis)) fail('偏好设置无效。'); result.remember = { measureBasis: plan.remember.measureBasis }; }
  if (plan.pending !== undefined && plan.pending !== null) { if (!isObject(plan.pending) || !text(plan.pending.text, 500)) fail('待续内容无效。'); result.pending = { text: plan.pending.text }; }
  return result;
}

/**
 * commands: the page's command interface (window.zhiyiCAD).
 * planners: { id: { id, name, canRevise?, plan(request) } }; plan may be async.
 * hostActions: { 'view.fit': fn, 'file.savePrj': fn, ... } supplied by the page.
 * preferences: { get(): object, set(patch) } kept by the page between visits.
 */
export function createAssistant({ commands, planners, hostActions = {}, getSelection = () => [], preferences = { get: () => ({}), set() {} }, maxRevisions = 2 }) {
  let pending = null, busy = false, context = { last: { entityIds: [], pieceIds: [] }, pending: null };
  const history = [];
  const remember = (role, content) => { history.push({ role, content: String(content).slice(0, 2000) }); while (history.length > 12) history.shift(); };
  const titles = () => new Map(commands.catalog().commands.map(c => [c.type, c.title]));
  function historyCommand(type) { return commands.execute({ schema: 'zhiyi-cad-command/v1', type, expectedRevision: commands.read().revision, parameters: {} }); }
  const builtIn = { 'history.undo': () => { historyCommand('history.undo'); return '已撤销。'; }, 'history.redo': () => { historyCommand('history.redo'); return '已重做。'; } };
  function runActions(actions) {
    const done = [];
    for (const { id } of actions) {
      const action = builtIn[id] || hostActions[id];
      if (!action) { done.push({ id, ok: false, message: '这个操作在当前页面不可用。' }); continue; }
      try { const message = action(); done.push({ id, ok: true, message: typeof message === 'string' ? message : '' }); }
      catch (error) { done.push({ id, ok: false, message: error.message }); }
    }
    return done;
  }
  function selection() {
    const ids = [...new Set(getSelection())].slice(0, 5000), chosen = new Set(ids), project = commands.readProject();
    return { entityIds: ids, pieceIds: (project.groups || []).filter(group => group.entityIds.some(id => chosen.has(id))).map(group => group.id) };
  }
  function discard() { if (pending) commands.clear(); pending = null; }

  /** Plan an instruction. Resolves to a reply, a proposal waiting for confirmation, or an error; the project is not changed. */
  async function ask(input, { planner: plannerId = 'local' } = {}) {
    if (busy) throw new Error('上一条指令还在处理。');
    const planner = planners[plannerId]; if (!planner) throw new Error('没有这个规划器。');
    const instruction = String(input ?? '').trim();
    if (!instruction) return { kind: 'reply', reply: '请输入要做的事。', assumptions: [], questions: [], choices: [], actions: [] };
    if (instruction.length > 2000) return { kind: 'reply', reply: '这句话太长了，请分成几句发送。', assumptions: [], questions: [], choices: [], actions: [] };
    busy = true; discard();
    try {
      const catalog = commands.catalog(); let feedback = null, plan, attempt = 0;
      for (;;) {
        const scene = commands.scene();
        try {
          plan = validatePlan(await planner.plan({ text: instruction, scene, catalog, actions: [...ASSISTANT_ACTIONS], history: copy(history), feedback,
            context: { last: copy(context.last), pending: context.pending, selection: selection(), preferences: copy(preferences.get() || {}) } }), catalog);
        } catch (error) { remember('user', instruction); return { kind: 'error', reply: '', error: error.message, planner: planner.id, choices: [], assumptions: [] }; }
        if (plan.remember) preferences.set(plan.remember);
        context.pending = plan.pending || null;
        if (!plan.steps.length) {
          const actions = runActions(plan.actions); remember('user', instruction); remember('assistant', plan.reply);
          return { kind: 'reply', planner: planner.id, reply: plan.reply, assumptions: plan.assumptions, questions: plan.questions, choices: plan.choices, actions };
        }
        try {
          const preview = commands.previewBatch({ schema: 'zhiyi-cad-batch/v1', expectedRevision: scene.revision, steps: plan.steps, label: instruction.slice(0, 200) }), title = titles();
          pending = { plan, preview, instruction };
          remember('user', instruction); remember('assistant', plan.reply);
          return { kind: 'proposal', planner: planner.id, reply: plan.reply, assumptions: plan.assumptions, choices: plan.choices, counts: preview.counts, preview,
            steps: preview.steps.map(step => ({ index: step.index, type: step.type, title: title.get(step.type) || step.type, summary: step.summary, measurements: step.measurements })),
            after: plan.actions.map(a => a.id) };
        } catch (error) {
          // A model can correct itself when told what went wrong; the offline parser cannot.
          if (planner.canRevise && attempt < maxRevisions) { attempt++; feedback = { error: error.message, step: error.step || null, steps: plan.steps }; continue; }
          remember('user', instruction);
          const choices = error.code === 'draft-edited' ? [{ label: '丢弃手工修改并重算', send: instruction + '，丢弃手工修改' }] : [];
          return { kind: 'error', planner: planner.id, reply: plan.reply, error: error.message, assumptions: plan.assumptions, choices, attempts: attempt + 1 };
        }
      }
    } finally { busy = false; }
  }
  /** Apply the pending proposal as one undo step, then run the actions that belong to it. */
  function apply() {
    if (!pending) throw new Error('没有等待确认的计划。');
    const { plan, preview } = pending; pending = null;
    let result;
    try { result = commands.apply(preview.id); }
    catch (error) { commands.clear(); return { kind: 'error', error: /变化|改变|失效/.test(error.message) ? '画布在预演之后发生了变化，这份计划已作废。请重新发送指令。' : error.message, choices: [], assumptions: [] }; }
    const project = commands.readProject(), entities = new Set(project.entities.map(e => e.id)), groups = new Set((project.groups || []).map(g => g.id)), created = preview.steps.map(s => s.created).filter(Boolean);
    // "它" means what the last plan made; when it made nothing, the pieces it worked on; otherwise what it meant before.
    const madeEntities = created.filter(id => entities.has(id)), madePieces = [...new Set([...created.filter(id => groups.has(id)), ...(project.metadata?.parametricDrafts || []).filter(d => created.includes(d.id)).flatMap(d => d.groupIds)])];
    const worked = [...new Set(plan.steps.map(step => step.parameters.groupId).filter(id => typeof id === 'string' && groups.has(id)))];
    context.last = { entityIds: madeEntities.length || madePieces.length ? madeEntities : context.last.entityIds.filter(id => entities.has(id)),
      pieceIds: madePieces.length ? madePieces : worked.length ? worked : madeEntities.length ? [] : context.last.pieceIds.filter(id => groups.has(id)) };
    const actions = runActions(plan.actions);
    remember('assistant', '已应用。');
    return { kind: 'applied', revision: result.revision, counts: preview.counts, actions, choices: plan.choices };
  }
  return Object.freeze({ ask, apply, discard, hasPending: () => Boolean(pending), isBusy: () => busy, planners: () => Object.values(planners).map(p => ({ id: p.id, name: p.name })),
    runAction: id => runActions([{ id }])[0], forget: () => { discard(); history.length = 0; context = { last: { entityIds: [], pieceIds: [] }, pending: null }; } });
}
