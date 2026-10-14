#!/usr/bin/env node
'use strict';

/**
 * 每日在寝打卡（接口版）
 *
 *   node checkin.js                    正常执行，日期 = 今天（本地时间）
 *   node checkin.js --dry-run          只打印将要发送的请求体，不发请求
 *   node checkin.js --date=2026-10-11  指定日期，用于补打
 *   node checkin.js --force            忽略「今天已成功」检查，强制重发
 *
 * 退出码：0 = 成功或今天已打卡；1 = 失败
 *
 * 依赖：Node 18+ 自带的全局 fetch。无需 npm install。
 */

const fs = require('fs');
const path = require('path');

// 一律从脚本所在目录派生路径，不硬编码用户目录
const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
// 可选的本地覆盖文件，用来放真实 token，不进版本库
const LOCAL_CONFIG_PATH = path.join(BASE_DIR, 'config.local.json');
const QUERY_PATH = path.join(BASE_DIR, 'query.gql');
const STATE_DIR = path.join(BASE_DIR, 'state');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'checkin.log');

const DEFAULTS = {
  endpoint: '',
  operationName: '',
  input: {},
  headers: {},
  // 服务端返回这些文案时，说明当天已经打过卡了 —— 按成功处理，不重试、不告警
  alreadyDonePatterns: ['您已完成接龙', '无需再接龙', '已经打卡', '已打卡'],
  retries: 3,
  retryDelayMs: 30000,
  timeoutMs: 15000,
  skipIfAlreadySucceededToday: true,
  webhookUrl: ''
};

// 这些头的值在日志里一律打码，避免 token 落到日志文件里
const SECRET_HEADER = /^(authorization|cookie|set-cookie|token|x-token|x-auth-token|x-access-token|signature|x-sign|x-signature)$/i;

function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const s = String(v);
    out[k] = SECRET_HEADER.test(k) ? `<已隐藏，共 ${s.length} 字符>` : s;
  }
  return out;
}

// ---------------------------------------------------------------- 工具

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 本地时区的 YYYY-MM-DD。不能用 toISOString()，那是 UTC，UTC+8 下会差一天。 */
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, dd] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, dd);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === dd;
}

function truncate(s, n = 500) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? `${s.slice(0, n)}…(${s.length} 字符)` : s;
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 预期内的用法/配置错误：只报一行消息，不打调用栈。 */
class UserError extends Error {}

function fail(msg) {
  throw new UserError(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level, msg) {
  const line = `${stamp()} [${level}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch (e) {
    // 日志写不进去也不能让主流程崩掉
    console.error(`(日志写入失败: ${e.message})`);
  }
}

// ---------------------------------------------------------------- 配置 / 状态

function readJson(file, label) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    fail(`${label} 解析失败：${e.message}`);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`找不到配置文件：${CONFIG_PATH}`);
  }
  const base = readJson(CONFIG_PATH, 'config.json');
  // config.local.json 可选，存在则覆盖 config.json 的对应字段（用来放真实 token）
  const local = fs.existsSync(LOCAL_CONFIG_PATH)
    ? readJson(LOCAL_CONFIG_PATH, 'config.local.json')
    : {};
  const raw = {
    ...base,
    ...local,
    input: { ...base.input, ...local.input },
    headers: { ...base.headers, ...local.headers }
  };
  // 缺失键自动补默认值
  return {
    ...DEFAULTS,
    ...raw,
    input: { ...DEFAULTS.input, ...(raw.input || {}) },
    headers: { ...DEFAULTS.headers, ...(raw.headers || {}) }
  };
}

function readState() {
  try {
    return JSON.parse(stripBom(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (e) {
    log('WARN', `状态文件写入失败：${e.message}`);
  }
  return next;
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, date: null, help: false };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--date=')) opts.date = a.slice('--date='.length).trim();
    else if (a === '--help' || a === '-h') opts.help = true;
    else fail(`未知参数：${a}（用 --help 看用法）`);
  }
  return opts;
}

function printHelp() {
  console.log(
    [
      '每日在寝打卡（接口版）',
      '',
      '  node checkin.js                    正常执行，日期 = 今天（本地时间）',
      '  node checkin.js --dry-run          只打印将要发送的请求体，不发请求',
      '  node checkin.js --date=2026-10-11  指定日期，用于补打',
      '  node checkin.js --force            忽略「今天已成功」检查，强制重发',
      '',
      '退出码：0 = 成功或今天已打卡；1 = 失败'
    ].join('\n')
  );
}

// ---------------------------------------------------------------- 请求

async function postOnce(cfg, body) {
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cfg.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON，保留原文供排查
  }
  return { status: res.status, text, json };
}

/**
 * 发起请求并分类结果。
 * 只对网络错误 / 超时 / 5xx 重试；业务错误重试也没有意义，直接返回。
 *
 * 返回 { ok: true, record } 表示成功；
 *      { ok: false, retryable: bool, detail } 表示失败。
 */
async function sendWithRetry(cfg, body) {
  let lastDetail = '未发起请求';

  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    let r;
    try {
      r = await postOnce(cfg, body);
    } catch (e) {
      lastDetail = e.name === 'TimeoutError' ? `请求超时（${cfg.timeoutMs}ms）` : `网络错误：${e.message}`;
      log('WARN', `第 ${attempt}/${cfg.retries} 次尝试失败：${lastDetail}`);
      if (attempt < cfg.retries) await sleep(cfg.retryDelayMs);
      continue;
    }

    if (r.status >= 500) {
      lastDetail = `HTTP ${r.status}：${truncate(r.text)}`;
      log('WARN', `第 ${attempt}/${cfg.retries} 次尝试失败：${lastDetail}`);
      if (attempt < cfg.retries) await sleep(cfg.retryDelayMs);
      continue;
    }

    if (!r.json) {
      return { ok: false, retryable: false, detail: `HTTP ${r.status} 返回非 JSON：${truncate(r.text)}` };
    }

    if (Array.isArray(r.json.errors) && r.json.errors.length > 0) {
      const joined = r.json.errors
        .map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e)))
        .join(' ');
      // 服务端说「已经接龙过了」= 当天已完成，算成功
      const hit = (cfg.alreadyDonePatterns || []).find((p) => p && joined.includes(p));
      if (hit) return { ok: true, alreadyDone: true, detail: joined };
      return { ok: false, retryable: false, detail: `GraphQL errors：${JSON.stringify(r.json.errors)}` };
    }

    const record = r.json.data && r.json.data[cfg.operationName];
    if (!record || !record._id) {
      return {
        ok: false,
        retryable: false,
        detail: `响应里没有 data.${cfg.operationName}._id：${truncate(r.text)}`
      };
    }

    return { ok: true, record };
  }

  return { ok: false, retryable: true, detail: `重试 ${cfg.retries} 次仍失败，最后错误：${lastDetail}` };
}

async function notify(cfg, title, message) {
  if (!cfg.webhookUrl) return; // 没配就完全跳过，不发任何外部请求
  try {
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content: message }),
      signal: AbortSignal.timeout(10000)
    });
    log('INFO', '失败告警已推送');
  } catch (e) {
    log('WARN', `告警推送失败：${e.message}`);
  }
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  const cfg = loadConfig();
  if (!cfg.endpoint) fail('config.json 里的 endpoint 为空');

  // 鉴权头缺失时报错要直白，否则只会看到服务端那句含糊的「需要同意授权读取微信公开信息」
  const auth = cfg.headers.authorization || '';
  if (auth.includes('<在这里填')) {
    fail(
      'authorization 还是占位符。请把真实 token 填进 config.local.json 的 headers.authorization' +
        '（该文件已被 .gitignore 排除，不会进版本库）。'
    );
  }
  if (!auth) {
    fail('缺少 authorization 请求头，服务端会拒绝。请参照 config.json 填好 headers。');
  }
  if (!cfg.operationName) fail('config.json 里的 operationName 为空');
  if (!fs.existsSync(QUERY_PATH)) fail(`找不到 GraphQL 语句文件：${QUERY_PATH}`);
  const query = fs.readFileSync(QUERY_PATH, 'utf8');

  const dateStr = opts.date || localDateStr();
  if (!isValidDateStr(dateStr)) {
    fail(`日期格式不对：${dateStr}，应为 YYYY-MM-DD`);
  }

  const body = {
    query,
    variables: { input: { ...cfg.input, submitDayStr: dateStr } },
    operationName: cfg.operationName
  };

  log(
    'INFO',
    `开始打卡，目标日期 submitDayStr=${dateStr}；配置来源：config.json` +
      (fs.existsSync(LOCAL_CONFIG_PATH) ? ' + config.local.json' : '（无本地覆盖）')
  );

  if (Object.keys(cfg.headers).length === 0) {
    log('WARN', 'config.json 的 headers 是空的。若服务端报「需要同意授权」之类的错误，就是缺了抓包里的鉴权头。');
  }

  if (opts.dryRun) {
    log('INFO', '--dry-run：只打印请求体和请求头，不发送请求');
    console.log('// 请求头（敏感值已打码）');
    console.log(JSON.stringify({ 'Content-Type': 'application/json', ...maskHeaders(cfg.headers) }, null, 2));
    console.log('\n// 请求体');
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }

  // 幂等：createBaomingByInput 是创建语义，同一天重复调用会产生多条记录
  const state = readState();
  if (cfg.skipIfAlreadySucceededToday && state.lastSuccessDate === dateStr && !opts.force) {
    log('INFO', `今天（${dateStr}）已经成功打卡过，跳过。需要重发请加 --force。`);
    return 0;
  }

  const result = await sendWithRetry(cfg, body);

  if (!result.ok) {
    log('ERROR', `打卡失败：${result.detail}`);
    writeState({
      lastFailureDate: dateStr,
      lastFailureAt: stamp(),
      lastFailureReason: result.detail,
      consecutiveFailures: (state.consecutiveFailures || 0) + 1
    });
    await notify(cfg, '打卡失败', `${dateStr} 打卡失败：${result.detail}`);
    return 1;
  }

  if (result.alreadyDone) {
    writeState({
      lastSuccessDate: dateStr,
      lastSuccessAt: stamp(),
      lastResult: 'ALREADY_DONE',
      lastResponseText: result.detail,
      consecutiveFailures: 0
    });
    log('INFO', `今天（${dateStr}）已经打过卡了，服务端回复：${result.detail}。无需重复提交，按成功处理。`);
    return 0;
  }

  const rec = result.record;
  writeState({
    lastSuccessDate: dateStr,
    lastSuccessAt: stamp(),
    lastResult: 'SUCCESS',
    lastResponseId: rec._id,
    consecutiveFailures: 0
  });

  log(
    'INFO',
    `打卡成功。_id=${rec._id} 服务端记录：submitDayStr=${rec.submitDayStr} ` +
      `submitDayIndex=${rec.submitDayIndex} no=${rec.no} createdAt=${rec.createdAt}`
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // 预期内的用法/配置错误只报一行；真正意外的异常才带调用栈
    const detail = e instanceof UserError || !e.stack ? e.message : e.stack;
    log('ERROR', `异常退出：${detail}`);
    process.exit(1);
  });
