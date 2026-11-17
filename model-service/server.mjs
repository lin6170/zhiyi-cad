#!/usr/bin/env node
/**
 * 智衣 CAD 模型服务（参考实现）。
 *
 * The drawing assistant of the page posts an instruction, a description of the canvas and
 * the command catalogue to  POST /v1/plan  and receives a plan. This process is the only
 * place that holds a model key. It runs on the user's own computer by default
 * (127.0.0.1) and answers only the page origins it was told about.
 *
 *   node server.mjs                 start the service
 *   node server.mjs --check         ask the model one small question and exit
 *   node server.mjs --provider demo no model, no key: try the connection
 *
 * Settings come from the environment, or from a file named .env beside this file.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { createPlanner, ServiceError, ModelError, REQUEST_SCHEMA } from './lib/planner.mjs';

export const SERVICE_VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
export const DEFAULT_ORIGINS = ['https://lin6170.github.io', 'http://localhost:4173', 'http://127.0.0.1:4173'];

/** KEY=VALUE lines; a value already in the environment wins. */
export function readEnvFile(path, env = process.env) {
  if (!existsSync(path)) return [];
  const loaded = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (env[match[1]] === undefined) { env[match[1]] = value; loaded.push(match[1]); }
  }
  return loaded;
}

/** Settings from the environment and the command line. Throws an Error with a message for the person starting the service. */
export function readConfig(env = process.env, argv = []) {
  const flag = name => { const index = argv.indexOf('--' + name); return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : undefined; };
  const integer = (name, fallback, least, most) => { const raw = env[name]; if (raw === undefined || raw === '') return fallback; const value = Number(raw); if (!Number.isInteger(value) || value < least || value > most) throw new Error(name + ' 须为 ' + least + ' 至 ' + most + ' 之间的整数。'); return value; };
  const provider = flag('provider') || env.MODEL_PROVIDER || 'anthropic';
  if (!['anthropic', 'openai-compatible', 'demo'].includes(provider)) throw new Error('MODEL_PROVIDER 须为 anthropic、openai-compatible 或 demo。');
  const host = flag('host') || env.HOST || '127.0.0.1', portText = flag('port') || env.PORT || '8787', port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 不是有效的端口号。');
  const origins = (env.ALLOWED_ORIGINS === undefined ? DEFAULT_ORIGINS : env.ALLOWED_ORIGINS.split(',')).map(item => item.trim()).filter(Boolean).map(item => {
    let url; try { url = new URL(item); } catch { throw new Error('ALLOWED_ORIGINS 里的“' + item + '”不是有效的网址。'); }
    if (url.origin === 'null' || !['http:', 'https:'].includes(url.protocol)) throw new Error('ALLOWED_ORIGINS 里的“' + item + '”不是网页地址。');
    return url.origin;
  });
  const accessCode = env.ACCESS_CODE || '';
  if (!LOOPBACK.includes(host) && !accessCode) throw new Error('服务不是只对本机开放（HOST=' + host + '）时，必须设置 ACCESS_CODE。');
  if (accessCode && accessCode.length < 8) throw new Error('ACCESS_CODE 至少要 8 个字符。');
  const publicHosts = (env.PUBLIC_HOSTS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return { provider, host, port, origins, accessCode, publicHosts, check: argv.includes('--check'),
    ratePerMinute: integer('RATE_PER_MINUTE', 20, 1, 600), maxConcurrent: integer('MAX_CONCURRENT', 2, 1, 50), maxBodyBytes: integer('MAX_BODY_BYTES', 2000000, 10000, 20000000),
    deadlineMs: integer('DEADLINE_MS', 80000, 5000, 600000), maxRepairs: integer('MAX_REPAIRS', 2, 0, 5), maxTokens: integer('MODEL_MAX_TOKENS', 0, 0, 128000),
    anthropicModel: env.ANTHROPIC_MODEL || '', anthropicEffort: env.ANTHROPIC_EFFORT || '', baseUrl: env.MODEL_BASE_URL || '', apiKey: env.MODEL_API_KEY || '', modelName: env.MODEL_NAME || '', toolChoice: env.MODEL_TOOL_CHOICE || 'auto' };
}

/** Build the provider the settings ask for. The modules are loaded on demand, so the demo mode needs nothing installed. */
export async function createModel(config, log = () => {}, nodeVersion = process.versions.node) {
  const major = Number(String(nodeVersion).split('.')[0]), needs = { anthropic: 20, 'openai-compatible': 18 }[config.provider];
  if (needs && major < needs) throw new ModelError('config', '这种模型接口需要 Node.js ' + needs + ' 或更新的版本，现在是 ' + nodeVersion + '。请到 https://nodejs.org/ 安装新版本。演示模式（--provider demo）不受这个限制。');
  if (config.provider === 'demo') return (await import('./providers/demo.mjs')).createDemoModel();
  if (config.provider === 'openai-compatible') return (await import('./providers/openai-compatible.mjs')).createOpenAiCompatibleModel({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.modelName, maxTokens: config.maxTokens, toolChoice: config.toolChoice, log });
  const { createAnthropicModel, DEFAULT_MODEL } = await import('./providers/anthropic.mjs');
  return createAnthropicModel({ model: config.anthropicModel || DEFAULT_MODEL, ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}), effort: config.anthropicEffort, log });
}

const same = (a, b) => { const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest(); return timingSafeEqual(x, y); };
const MODEL_STATUS = { auth: 502, rate: 429, timeout: 504, connection: 502, upstream: 502, config: 500 };

/**
 * The HTTP service. model: a provider; config: from readConfig; log: one line per request, never the
 * instruction, the canvas, the key or the access code.
 */
export function createService({ model, config, log = line => console.log(line), now = () => Date.now() }) {
  const planner = createPlanner({ model, maxRepairs: config.maxRepairs, deadlineMs: config.deadlineMs });
  const origins = new Set(config.origins), recent = [];
  let running = 0;

  const hostAllowed = header => {
    const name = String(header || '').toLowerCase().replace(/:\d+$/, '');
    return LOOPBACK.includes(name) || config.publicHosts.includes(name);
  };
  function send(res, status, body, origin, extra = {}) {
    const text = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, { ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}), ...extra });
    res.end(text);
  }
  const fail = (res, status, message, origin, code = 'error') => send(res, status, { error: message, code }, origin);

  async function handle(req, res) {
    const started = now(), claimed = String(req.headers.origin || ''), origin = /^https?:\/\/[A-Za-z0-9.\-[\]:]{1,200}$/.test(claimed) ? claimed : '', allowedOrigin = origin && origins.has(origin) ? origin : '';
    let path; try { path = new URL(req.url, 'http://service').pathname; } catch { return fail(res, 400, '地址无效。', ''); }
    const note = (status, extra = '') => log(new Date(started).toISOString() + ' ' + req.method + ' ' + path + ' ' + status + ' ' + (now() - started) + 'ms' + (origin ? ' origin=' + origin : '') + extra);
    // A page on another site that points a name of its own at this computer is stopped here.
    if (!hostAllowed(req.headers.host)) { note(421); return fail(res, 421, '这个服务不接受以该主机名发来的请求。', ''); }
    if (claimed && !origin) { note(403); return fail(res, 403, '来源无效。', ''); }
    // The browser's question before a request is answered for any page, and a page that is not on the list then gets a
    // refusal it can read, so that it can tell its user what to change. It gets nothing else, and no model is asked.
    if (req.method === 'OPTIONS') {
      if (!origin) { note(403); return fail(res, 403, '缺少来源。', ''); }
      note(204);
      return send(res, 204, null, origin, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600',
        ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}) });
    }
    if (origin && !allowedOrigin) { note(403); return fail(res, 403, '这个服务没有允许来自 ' + origin + ' 的页面。请把这个网址加到服务端的 ALLOWED_ORIGINS 里，再重新启动服务。', origin, 'origin'); }
    const route = req.method + ' ' + path;
    if (route !== 'GET /v1/health' && route !== 'POST /v1/plan') { note(404); return fail(res, 404, '没有这个地址。计划接口是 POST /v1/plan。', allowedOrigin); }
    if (config.accessCode) {
      const given = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!given || !same(given[1], config.accessCode)) { note(401); return fail(res, 401, '访问码不对。', allowedOrigin, 'unauthorised'); }
    }
    if (route === 'GET /v1/health') { note(200); return send(res, 200, { ok: true, service: 'zhiyi-model-service', version: SERVICE_VERSION, request: REQUEST_SCHEMA, provider: model.id, model: model.model, demo: model.id === 'demo' }, allowedOrigin); }

    // A page cannot send JSON to another origin without asking first, so this keeps other sites from spending the key.
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { note(415); return fail(res, 415, '请求内容必须是 application/json。', allowedOrigin); }
    while (recent.length && recent[0] <= started - 60000) recent.shift();
    if (recent.length >= config.ratePerMinute) { note(429); return fail(res, 429, '请求太频繁，请过一会儿再试。', allowedOrigin, 'rate'); }
    if (running >= config.maxConcurrent) { note(429); return fail(res, 429, '上一条指令还在处理，请稍等。', allowedOrigin, 'busy'); }
    recent.push(started); running++;
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      // An oversize request is read to its end and dropped, so that the caller receives the answer instead of a broken connection.
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size <= config.maxBodyBytes) chunks.push(chunk); else { chunks.length = 0; if (size > config.maxBodyBytes * 8) { req.destroy(); break; } } }
      if (size > config.maxBodyBytes) throw new ServiceError(413, '画布内容太多，超过了服务能接收的大小。', 'too-large');
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError(400, '请求不是有效的 JSON。', 'bad-request'); }
      const { plan, meta } = await planner.plan(body, { signal: controller.signal });
      if (controller.signal.aborted || res.destroyed) { note(499); return; }
      note(200, ' steps=' + plan.steps.length + ' rounds=' + meta.rounds + ' in=' + meta.usage.inputTokens + ' out=' + meta.usage.outputTokens + ' cached=' + meta.usage.cacheReadTokens);
      send(res, 200, { ...plan, meta: { provider: meta.provider, model: meta.model, rounds: meta.rounds } }, allowedOrigin);
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) { note(499); return; }
      if (error instanceof ServiceError) { note(error.status, ' ' + error.code); return fail(res, error.status, error.message, allowedOrigin, error.code); }
      if (error instanceof ModelError) { const status = MODEL_STATUS[error.code] || 502; note(status, ' model-' + error.code); return fail(res, status, error.message, allowedOrigin, 'model-' + error.code); }
      note(500); log(String(error?.stack || error).slice(0, 2000));
      fail(res, 500, '服务内部出错，详情见服务端窗口里的记录。', allowedOrigin);
    } finally { running--; }
  }

  const server = createServer((req, res) => { handle(req, res).catch(error => { log(String(error?.stack || error).slice(0, 2000)); if (!res.headersSent) fail(res, 500, '服务内部出错。', ''); else res.destroy(); }); });
  server.requestTimeout = config.deadlineMs + 30000; server.headersTimeout = 20000;
  return {
    server, planner,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolve(server.address()); }); }),
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

/** One small request through the whole chain, to see whether the model can be reached. */
export async function selfCheck(model, config) {
  const planner = createPlanner({ model, maxRepairs: config.maxRepairs, deadlineMs: config.deadlineMs });
  const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false };
  const { plan, meta } = await planner.plan({ schema: REQUEST_SCHEMA, locale: 'zh-CN', units: 'mm', instruction: '画一条从原点向右 10 厘米的水平线', history: [], scene: { revision: 0, units: 'mm', name: '自检', entityCount: 0, pieceCount: 0, bbox: null, pieces: [], looseEntities: [], drafts: [] },
    selection: { entityIds: [], pieceIds: [] }, last: { entityIds: [], pieceIds: [] }, preferences: { lengthUnit: 'cm' }, actions: ['view.fit'], feedback: null,
    commands: [{ type: 'draw.line', title: '画直线', description: '在两点之间画一条直线。', input_schema: { type: 'object', properties: { from: point, to: point, name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['from', 'to'], additionalProperties: false } }] });
  return { plan, meta };
}

async function main() {
  const argv = process.argv.slice(2);
  readEnvFile(join(HERE, '.env'));
  let config, model;
  try { config = readConfig(process.env, argv); model = await createModel(config, line => console.log(line)); }
  catch (error) { console.error('启动失败：' + error.message); process.exit(1); }
  if (config.check) {
    try {
      const { plan, meta } = await selfCheck(model, config);
      console.log('模型：' + meta.model + '（' + meta.provider + '），用时 ' + meta.ms + ' 毫秒，往返 ' + meta.rounds + ' 次。');
      console.log('回答：' + plan.reply);
      console.log('步骤：' + (plan.steps.length ? plan.steps.map(step => step.type + ' ' + JSON.stringify(step.parameters)).join('；') : '（没有步骤）'));
      console.log(plan.steps.length ? '自检通过。' : '模型有回答，但没有给出画图步骤，请看上面的回答。');
      process.exit(plan.steps.length ? 0 : 2);
    } catch (error) { console.error('自检失败：' + error.message); process.exit(1); }
  }
  const service = createService({ model, config });
  let address;
  try { address = await service.listen(); }
  catch (error) { console.error('启动失败：' + (error.code === 'EADDRINUSE' ? '端口 ' + config.port + ' 已被占用，请关掉占用它的程序，或用 PORT 换一个端口。' : error.message)); process.exit(1); }
  const shown = (LOOPBACK.includes(config.host) ? '127.0.0.1' : config.host) + ':' + address.port;
  console.log('智衣 CAD 模型服务已启动。');
  console.log('  服务地址：http://' + shown + '   （把它填到网页“制版助手 → 设置 → 模型服务 → 服务地址”）');
  console.log(model.id === 'demo' ? '  模型：没有接大模型（演示模式）' : '  模型：' + model.model + '（' + model.id + '）');
  console.log('  允许的网页：' + config.origins.join('、'));
  console.log('  访问码：' + (config.accessCode ? '已设置' : '未设置（只对本机开放）'));
  console.log('关掉这个窗口，或按 Ctrl+C，服务就停止。');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { service.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
