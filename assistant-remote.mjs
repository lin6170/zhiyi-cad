/**
 * Client for a model service that plans drawing commands. The browser never holds a
 * model key: it posts the instruction, a description of the canvas and the command
 * catalogue to a service the user has configured, and receives a plan in the same
 * format the offline parser produces. The plan is validated and previewed like any other.
 *
 *   POST {serviceUrl}/v1/plan      Content-Type: application/json
 *   request  { schema: 'zhiyi-agent-request/v1', locale, units, instruction, history, scene,
 *              selection, last, preferences, commands, actions, feedback }
 *   response { schema: 'zhiyi-agent-plan/v1', reply, steps, actions, assumptions, questions, choices }
 *
 * "feedback" is set when the previous plan failed its preview: { error, step, steps }.
 * A service that cannot answer may say why:  { error: '一句话' }  with a 4xx or 5xx status.
 *
 *   GET {serviceUrl}/v1/health     → { ok: true, request: 'zhiyi-agent-request/v1', provider, model, demo }
 */
export const REQUEST_SCHEMA = 'zhiyi-agent-request/v1';
const MAX_RESPONSE = 1024 * 1024;
/** The reason a service gave for not answering: one short line of plain text, or nothing. */
function said(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 4000) return '';
  try { const body = JSON.parse(raw); return typeof body?.error === 'string' ? [...body.error].filter(c => c.codePointAt(0) >= 32).join('').trim().slice(0, 300) : ''; } catch { return ''; }
}
const REQUEST_OPTIONS = { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
/**
 * The body of a response, read while the timer of its request still runs: a service that sends its headers and then stalls
 * must not keep the page waiting (up to v74 the timer stopped with the headers). Rejects when the request's signal aborts,
 * whether or not the fetch in use ties its body to the signal.
 */
function readBody(response, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error('aborted'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(() => response.text()).then(
      text => { signal.removeEventListener('abort', stop); resolve(text); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
  });
}

/** A service address the page may call: https, or http on this computer only. Returns the normalised base address. */
export function checkServiceUrl(value) {
  let url; try { url = new URL(String(value).trim()); } catch { throw new Error('服务地址不是有效的网址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('服务地址须以 https:// 开头；只有本机地址（localhost）可以用 http://。');
  if (url.username || url.password) throw new Error('服务地址里不能带用户名或密码。');
  if (url.search || url.hash) throw new Error('服务地址里不能带参数。');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** getSettings(): { serviceUrl, accessCode? }. fetchImpl is injectable for tests. */
export function createRemotePlanner({ getSettings, fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 90000 }) {
  async function plan({ text, scene, catalog, actions, history, feedback, context }) {
    const settings = getSettings() || {};
    if (!settings.serviceUrl) throw new Error('还没有设置模型服务地址。');
    const base = checkServiceUrl(settings.serviceUrl), controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = JSON.stringify({ schema: REQUEST_SCHEMA, locale: 'zh-CN', units: 'mm', instruction: text, history: history || [], scene, selection: context?.selection || { entityIds: [], pieceIds: [] },
      last: context?.last || { entityIds: [], pieceIds: [] }, preferences: context?.preferences || {}, commands: catalog.commands, actions: actions || [], feedback: feedback || null });
    let response, raw;
    try {
      response = await fetchImpl(base + '/v1/plan', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(settings.accessCode ? { Authorization: 'Bearer ' + settings.accessCode } : {}) }, body,
        signal: controller.signal, ...REQUEST_OPTIONS });
      try { raw = await readBody(response, controller.signal); } catch (error) { if (controller.signal.aborted) throw error; raw = ''; }
    } catch (error) {
      const seconds = Math.round(timeoutMs / 1000);
      throw new Error(!controller.signal.aborted ? '连不上模型服务，请检查地址和网络。' : response ? '模型服务在 ' + seconds + ' 秒内没有把回应传完。' : '模型服务在 ' + seconds + ' 秒内没有回应。');
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const reason = said(raw);
      if (response.status === 401) throw new Error('模型服务拒绝了访问，请检查访问码。');
      if (response.status === 403) throw new Error(reason ? '模型服务拒绝了访问：' + reason : '模型服务拒绝了访问，请检查访问码。');
      if (response.status === 429) throw new Error(reason ? '模型服务：' + reason : '模型服务正忙或额度已用完，请稍后再试。');
      throw new Error(reason ? '模型服务：' + reason + '（HTTP ' + response.status + '）' : '模型服务出错（HTTP ' + response.status + '）。');
    }
    if (raw.length > MAX_RESPONSE) throw new Error('模型服务返回的内容过大。');
    try { return JSON.parse(raw); } catch { throw new Error('模型服务返回的不是有效的计划。'); }
  }
  return Object.freeze({ id: 'remote', name: '模型服务', canRevise: true, plan });
}

/** Ask a service whether it is there and which model it uses. Resolves to { provider, model, demo }; throws with a reason. */
export async function checkService({ serviceUrl, accessCode = '' }, { fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 10000 } = {}) {
  const base = checkServiceUrl(serviceUrl), controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let response, raw;
  try {
    response = await fetchImpl(base + '/v1/health', { method: 'GET', headers: accessCode ? { Authorization: 'Bearer ' + accessCode } : {}, signal: controller.signal, ...REQUEST_OPTIONS });
    try { raw = await readBody(response, controller.signal); } catch (error) { if (controller.signal.aborted) throw error; raw = ''; }
  } catch {
    const seconds = Math.round(timeoutMs / 1000);
    throw new Error(!controller.signal.aborted ? '连不上这个地址。请确认服务已经启动、地址没有写错；浏览器询问是否允许访问本机网络时，请选“允许”。'
      : response ? '这个地址在 ' + seconds + ' 秒内没有把回应传完。' : '这个地址在 ' + seconds + ' 秒内没有回应。');
  } finally { clearTimeout(timer); }
  if (response.status === 401) throw new Error('访问码不对。');
  if (!response.ok) throw new Error(said(raw) || '这个地址有回应，但不是可用的模型服务（HTTP ' + response.status + '）。');
  let body = null; try { body = JSON.parse(raw); } catch { /* not a service of this kind */ }
  if (!body || body.ok !== true || body.request !== REQUEST_SCHEMA) throw new Error('这个地址有回应，但不是智衣 CAD 的模型服务。');
  const short = (value, max) => [...String(value ?? '')].filter(c => c.codePointAt(0) >= 32).join('').slice(0, max);
  return { provider: short(body.provider, 60), model: short(body.model, 80), demo: body.demo === true };
}
