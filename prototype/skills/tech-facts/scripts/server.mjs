#!/usr/bin/env node
// tech-facts UI server — zero-dep, Node >= 18. Контракт: ../ui-protocol.md
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(SCRIPT_DIR, '..', 'ui');
const DEFAULT_PORT = 4747;
const STAGES = ['picker', 'review', 'explore'];
// Файл payload'а для каждой стадии (относительно workdir)
const STAGE_PAYLOAD = { picker: 'picker.json', review: 'review.json', explore: 'site/site.json' };
const FILE_WHITELIST = new Set([
  'state.json', 'picker.json', 'review.json',
  'site/site.json', 'site/facts.json', 'site/entities.json', 'decisions.jsonl',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- утилиты ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function fail(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function nowIso() { return new Date().toISOString(); }

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function tryReadJson(file) {
  try { return readJsonFile(file); } catch { return null; }
}

// Атомарная запись: tmp + rename
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readState(workdir) {
  return tryReadJson(path.join(workdir, 'state.json')) ?? { stage: 'idle' };
}

function resolvePort(args) {
  const fromArg = args.port !== undefined ? Number(args.port) : NaN;
  if (!Number.isNaN(fromArg) && fromArg > 0) return fromArg;
  const fromEnv = Number(process.env.TECHFACTS_PORT);
  if (!Number.isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_PORT;
}

function requireWorkdir(args) {
  if (!args.workdir) fail('Ошибка: не указан --workdir <dir>');
  return path.resolve(String(args.workdir));
}

async function fetchHealth(port, timeoutMs = 700) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- serve ----------

async function cmdServe(args) {
  const workdir = requireWorkdir(args);
  const port = resolvePort(args);
  const url = `http://127.0.0.1:${port}`;

  // Уже запущен на этом порте?
  const health = await fetchHealth(port);
  if (health && health.ok) {
    if (health.workdir && path.resolve(health.workdir) === workdir) {
      console.log(`already running at ${url}`);
      process.exit(0);
    }
    fail(`Ошибка: порт ${port} занят другим процессом (workdir: ${health.workdir ?? 'неизвестен'}).\n` +
         `Задайте другой порт через TECHFACTS_PORT или --port.`);
  }

  fs.mkdirSync(path.join(workdir, 'site'), { recursive: true });

  // --- SSE-клиенты и оповещение об изменениях ---
  const sseClients = new Set();
  let eventSeq = 0;
  let debounceTimer = null;

  function broadcast() {
    eventSeq++;
    const msg = `event: state\ndata: ${JSON.stringify({ seq: eventSeq })}\n\n`;
    for (const res of sseClients) {
      try { res.write(msg); } catch { sseClients.delete(res); }
    }
  }

  function notifyChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(broadcast, 150); // debounce 150ms
  }

  // fs.watch + poll-фоллбек (fs.watch ненадёжен на macOS/сетевых дисках)
  const watched = new Map(); // dir -> watcher
  function watchDir(dir) {
    if (watched.has(dir) || !fs.existsSync(dir)) return;
    try {
      const w = fs.watch(dir, notifyChange);
      w.on('error', () => { w.close(); watched.delete(dir); });
      watched.set(dir, w);
    } catch { /* не критично: остаётся поллинг */ }
  }
  watchDir(workdir);
  watchDir(path.join(workdir, 'site'));

  const RELEVANT = ['state.json', 'picker.json', 'review.json',
    'site/site.json', 'site/facts.json', 'site/entities.json', 'decisions.jsonl'];
  let lastSig = '';
  function pollSignature() {
    return RELEVANT.map((rel) => {
      try {
        const st = fs.statSync(path.join(workdir, rel));
        return `${rel}:${st.mtimeMs}:${st.size}`;
      } catch { return `${rel}:-`; }
    }).join('|');
  }
  lastSig = pollSignature();
  const pollTimer = setInterval(() => {
    watchDir(path.join(workdir, 'site')); // site/ мог появиться позже
    const sig = pollSignature();
    if (sig !== lastSig) { lastSig = sig; notifyChange(); }
  }, 1000);
  pollTimer.unref();

  const pingTimer = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
    }
  }, 25000);
  pingTimer.unref();

  // --- обработчики ---

  function handleHealth(res) {
    const state = readState(workdir);
    sendJson(res, 200, { ok: true, stage: state.stage ?? 'idle', workdir, pid: process.pid });
  }

  function handleState(res) {
    const state = readState(workdir);
    const payloadRel = STAGE_PAYLOAD[state.stage];
    const payload = payloadRel ? tryReadJson(path.join(workdir, payloadRel)) : null;
    // Стадии живут параллельно: UI сам решает, что показать, — говорим ему, что вообще есть.
    const available = {};
    for (const [stage, rel] of Object.entries(STAGE_PAYLOAD)) {
      available[stage === 'explore' ? 'site' : stage] = fs.existsSync(path.join(workdir, rel));
    }
    sendJson(res, 200, { state, payload, available });
  }

  /** Журнал решений человека: по нему UI помнит, что уже отправлено (переживает перезагрузку). */
  function handleDecisions(res) {
    const file = path.join(workdir, 'decisions.jsonl');
    let out = [];
    try {
      out = fs.readFileSync(file, 'utf8').split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch { /* решений ещё не было */ }
    sendJson(res, 200, out);
  }

  function handleFile(res, rawName) {
    let name;
    try { name = decodeURIComponent(rawName); } catch { return sendJson(res, 400, { error: 'bad path' }); }
    // Нормализация схлопывает "a/../b"; после неё проверяем по белому списку
    let normalized = path.posix.normalize(name.replaceAll('\\', '/'));
    // Короткие имена файлов сайта разрешаем без префикса site/
    if (!FILE_WHITELIST.has(normalized) && FILE_WHITELIST.has('site/' + normalized)) {
      normalized = 'site/' + normalized;
    }
    if (!FILE_WHITELIST.has(normalized)) return sendJson(res, 403, { error: 'forbidden' });
    const abs = path.join(workdir, normalized);
    if (!abs.startsWith(workdir + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(abs)) return sendJson(res, 404, { error: 'not found' });
    const type = normalized.endsWith('.jsonl') ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type });
    res.end(fs.readFileSync(abs));
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }

  function handleDecision(req, res) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      let decision;
      try {
        decision = JSON.parse(body);
        if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) throw new Error();
      } catch { return sendJson(res, 400, { error: 'malformed JSON' }); }
      try {
        fs.mkdirSync(workdir, { recursive: true });
        const file = path.join(workdir, 'decisions.jsonl');
        // seq = число уже записанных строк + 1
        let seq = 1;
        try {
          const existing = fs.readFileSync(file, 'utf8');
          seq = existing.split('\n').filter((l) => l.trim()).length + 1;
        } catch { /* файла ещё нет */ }
        const enriched = { ...decision, seq, at: nowIso() };
        fs.appendFileSync(file, JSON.stringify(enriched) + '\n');
        sendJson(res, 200, { ok: true, seq });
      } catch (e) {
        sendJson(res, 500, { error: String(e?.message ?? e) });
      }
    });
  }

  function handleStatic(res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'bad path' }); }
    if (rel === '/') rel = '/index.html';
    const abs = path.resolve(UI_DIR, '.' + path.posix.normalize(rel));
    if (abs !== UI_DIR && !abs.startsWith(UI_DIR + path.sep)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return sendJson(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(abs));
  }

  const server = http.createServer((req, res) => {
    try {
      const { pathname } = new URL(req.url, url);
      // Сырой путь до нормализации точек: new URL() схлопывает "..",
      // и запрос /api/file/../../x иначе утёк бы в статику вместо 403.
      const rawPath = req.url.split('?')[0];
      if (req.method === 'GET' && pathname === '/api/health') return handleHealth(res);
      if (req.method === 'GET' && pathname === '/api/state') return handleState(res);
      if (req.method === 'GET' && pathname === '/api/decisions') return handleDecisions(res);
      if (req.method === 'GET' && rawPath.startsWith('/api/file/')) {
        return handleFile(res, rawPath.slice('/api/file/'.length));
      }
      if (req.method === 'GET' && pathname === '/api/events') return handleEvents(req, res);
      if (req.method === 'POST' && pathname === '/api/decision') return handleDecision(req, res);
      if (req.method === 'GET') return handleStatic(res, pathname);
      sendJson(res, 405, { error: 'method not allowed' });
    } catch (e) {
      try { sendJson(res, 500, { error: String(e?.message ?? e) }); } catch { /* ответ уже ушёл */ }
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      fail(`Ошибка: порт ${port} уже занят. Задайте другой порт через TECHFACTS_PORT или --port.`);
    }
    fail(`Ошибка сервера: ${e.message}`);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`tech-facts UI: ${url}  (workdir: ${workdir})`);
    if (args.open) openBrowser(url);
  });
}

function openBrowser(url) {
  try {
    const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* не критично */ }
}

// ---------- push ----------

// ---------- валидация payload'ов ----------

// Проверяем ТОЛЬКО мини-ядро контракта. Схему фактов, состав срезов и любые
// дополнительные поля агент проектирует сам — валидатор в это не лезет.
const MAX_STATEMENT = 200;

function validatePayload(stage, payload) {
  const errors = [];   // ломают контракт → push не проходит
  const warnings = []; // косметика первого экрана → печатаем и едем дальше

  const checkFacts = (facts, where) => {
    if (!Array.isArray(facts)) return;
    facts.forEach((f, i) => {
      const id = (f && f.id) || `${where}[${i}]`;
      if (!f || typeof f !== 'object') { errors.push(`${id}: факт не объект`); return; }
      if (!f.id) errors.push(`${id}: нет id`);
      if (!f.statement || !String(f.statement).trim()) errors.push(`${id}: нет statement`);
      if (!Array.isArray(f.evidence) || !f.evidence.length) {
        errors.push(`${id}: нет evidence — факт без evidence не существует`);
      }
      if (f.statement && String(f.statement).length > MAX_STATEMENT) {
        warnings.push(`${id}: statement ${String(f.statement).length} символов (ориентир ≤ ${MAX_STATEMENT})`);
      }
    });
  };

  if (stage === 'picker') {
    const slices = payload && payload.slices;
    if (!Array.isArray(slices) || !slices.length) errors.push('picker.json: нет slices[]');
    else {
      const seen = new Set();
      slices.forEach((s, i) => {
        const id = (s && s.id) || `slices[${i}]`;
        if (!s || !s.id) errors.push(`${id}: нет id`);
        else if (seen.has(s.id)) errors.push(`${s.id}: дубль id среза`);
        else seen.add(s.id);
        if (!s || !s.title) errors.push(`${id}: нет title`);
        if (s && !s.summary) warnings.push(`${id}: нет summary — на карточке будет обрезок found`);
        else if (s && s.summary.length > 80) warnings.push(`${id}: summary ${s.summary.length} символов (карточка рассчитана на ≤ 80)`);
        if (s && !s.art) warnings.push(`${id}: нет art — карточка останется без иллюстрации`);
      });
      const rec = slices.filter((s) => s && s.recommended).length;
      if (rec > 3) warnings.push(`recommended у ${rec} срезов — UI отметит только первые 3`);
    }
  }

  if (stage === 'review') {
    const batches = Array.isArray(payload && payload.batches) ? payload.batches
      : (Array.isArray(payload && payload.facts) ? [payload] : null);
    if (!batches) errors.push('review.json: нет batches[] (и это не одиночный батч с facts[])');
    else {
      const seen = new Set();
      batches.forEach((b, i) => {
        const name = (b && b.batch) || `batches[${i}]`;
        if (!b || !b.batch) errors.push(`${name}: нет batch (id порции)`);
        else if (seen.has(b.batch)) errors.push(`${b.batch}: дубль порции`);
        else seen.add(b.batch);
        const status = b && b.status;
        if (status && !['extracting', 'ready', 'applied'].includes(status)) {
          warnings.push(`${name}: неизвестный status «${status}» — UI поймёт его как ready`);
        }
        if (status !== 'extracting') checkFacts(b && b.facts, name);
      });
    }
  }

  if (stage === 'explore') {
    const pages = payload && payload.pages;
    if (!Array.isArray(pages) || !pages.length) errors.push('site.json: нет pages[]');
  }

  return { errors, warnings };
}

function cmdPush(args) {
  const stage = args._[0];
  if (!STAGES.includes(stage)) {
    fail(`Ошибка: неизвестная стадия «${stage ?? ''}». Допустимые: ${STAGES.join(', ')}.`);
  }
  const workdir = requireWorkdir(args);

  const required = [STAGE_PAYLOAD[stage]];
  if (stage === 'explore') required.push('site/facts.json');
  let payload = null;
  for (const rel of required) {
    const abs = path.join(workdir, rel);
    if (!fs.existsSync(abs)) {
      fail(`Ошибка: файл payload не найден: ${abs}\nСтадия «${stage}» требует ${required.join(' и ')}.`);
    }
    try {
      const data = readJsonFile(abs);
      if (rel === STAGE_PAYLOAD[stage]) payload = data;
    } catch (e) {
      fail(`Ошибка: файл ${abs} не парсится как JSON: ${e.message}`);
    }
  }

  const { errors, warnings } = validatePayload(stage, payload);
  for (const w of warnings) process.stderr.write(`Предупреждение: ${w}\n`);
  if (errors.length && !args.force) {
    fail(`Ошибка: payload стадии «${stage}» нарушает мини-ядро контракта:\n`
      + errors.map((e) => `  · ${e}`).join('\n')
      + `\nПочини факты (это железные правила скилла) или пропусти проверку: --force.`);
  }
  if (errors.length) process.stderr.write(`Предупреждение: --force, пропущено нарушений: ${errors.length}\n`);

  const state = readState(workdir);
  const next = {
    ...state,
    stage,
    seq: (Number(state.seq) || 0) + 1,
    updated_at: nowIso(),
  };
  writeJsonAtomic(path.join(workdir, 'state.json'), next);
  const port = resolvePort(args);
  console.log(`Стадия «${stage}» опубликована (seq ${next.seq}). UI: http://127.0.0.1:${port}`);
}

// ---------- await ----------

/** Два await на одном workdir дерутся за один курсор `.ack` — второй молча зависал бы навсегда. */
function acquireAwaitLock(workdir) {
  const lockFile = path.join(workdir, '.await.lock');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: 'wx' });
      const release = () => { try { fs.unlinkSync(lockFile); } catch { /* уже убрали */ } };
      process.on('exit', release);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(130); });
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = tryReadJson(lockFile);
      if (held && held.pid && alive(held.pid)) {
        fail(`Ошибка: на этом workdir уже ждёт решения другой await (pid ${held.pid}, с ${held.at}).\n`
          + `Два await делят один курсор .ack — второй заберёт чужое решение или зависнет.\n`
          + `Дождись первого или сними его; если процесса уже нет, удали ${lockFile}.`, 4);
      }
      // лок от умершего процесса — забираем
      try { fs.unlinkSync(lockFile); } catch { /* кто-то опередил */ }
    }
  }
  fail('Ошибка: не удалось взять лок await — попробуй ещё раз.', 4);
  return () => {};
}

async function cmdAwait(args) {
  const workdir = requireWorkdir(args);
  const releaseLock = acquireAwaitLock(workdir);
  const stageFilter = args.stage ? String(args.stage) : null;
  const timeoutSec = args.timeout !== undefined ? Number(args.timeout) : 540;
  const deadline = Date.now() + timeoutSec * 1000;
  const decisionsFile = path.join(workdir, 'decisions.jsonl');
  const ackFile = path.join(workdir, '.ack');

  const readAck = () => {
    try {
      const n = parseInt(fs.readFileSync(ackFile, 'utf8').trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch { return 0; }
  };

  // Ищет первую подходящую запись после offset; возвращает {line, newOffset} или null.
  // Читаем только завершённые (с \n) строки: незаконченная запись дочитается на следующем цикле.
  function scan(offset) {
    let buf;
    try { buf = fs.readFileSync(decisionsFile); } catch { return null; }
    let pos = offset;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break;
      const lineBuf = buf.subarray(pos, nl);
      const end = nl + 1;
      const text = lineBuf.toString('utf8').trim();
      if (text) {
        let obj = null;
        try { obj = JSON.parse(text); } catch { /* битая строка — пропускаем и потребляем */ }
        if (obj && (!stageFilter || obj.stage === stageFilter)) {
          return { line: JSON.stringify(obj), newOffset: end };
        }
        // Чужая стадия: не потребляем — иначе в параллельном режиме решение человека
        // (например правка состава срезов) молча пропало бы. Ждём await без фильтра.
        if (obj) return null;
      }
      pos = end; // битая строка — пропускаем
    }
    return null;
  }

  while (true) {
    const found = scan(readAck());
    if (found) {
      fs.writeFileSync(ackFile, String(found.newOffset));
      console.log(found.line);
      releaseLock();
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.log('{"timeout":true}');
      releaseLock();
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------- status ----------

async function cmdStatus(args) {
  const workdir = requireWorkdir(args);
  const port = resolvePort(args);
  const health = await fetchHealth(port);
  if (health && health.ok && health.workdir && path.resolve(health.workdir) === workdir) {
    console.log(`stage: ${health.stage}  url: http://127.0.0.1:${port}`);
    process.exit(0);
  }
  console.log('не запущен');
  process.exit(1);
}

// ---------- export ----------

// Самодостаточная read-only страница эксплорера (для Claude Artifacts / шаринга):
// шелл + вшитые данные, работает без сервера.
function cmdExport(args) {
  const workdir = requireWorkdir(args);
  const out = path.resolve(args.out || 'tech-facts-site.html');
  const site = tryReadJson(path.join(workdir, 'site/site.json'));
  const facts = tryReadJson(path.join(workdir, 'site/facts.json'));
  if (!site || !facts) fail('Для экспорта нужны site/site.json и site/facts.json в workdir.');
  const entities = tryReadJson(path.join(workdir, 'site/entities.json'));
  const state = tryReadJson(path.join(workdir, 'state.json')) || {};

  const embedded = {
    state: { stage: 'explore', project: site.project || state.project, seq: state.seq || 0 },
    payload: site,
    files: { 'facts.json': facts, ...(entities ? { 'entities.json': entities } : {}) },
  };
  // </script> внутри JSON-строк разорвал бы инлайн-скрипт
  const embeddedJson = JSON.stringify(embedded).replaceAll('</script>', '<\\/script>');

  let html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(UI_DIR, 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(UI_DIR, 'app.js'), 'utf8');
  const mermaid = fs.readFileSync(path.join(UI_DIR, 'vendor/mermaid.min.js'), 'utf8');

  const title = site.project ? `${site.project} · tech-facts` : 'tech-facts';
  html = html
    .replace('<title>tech-facts</title>', () => `<title>${title}</title>`)
    .replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script src="./vendor/mermaid.min.js"></script>',
      () => `<script>window.TECHFACTS_EMBEDDED = ${embeddedJson};</script>\n<script>${mermaid}</script>`)
    .replace('<script type="module" src="./app.js"></script>', () => `<script type="module">\n${appJs}\n</script>`);

  // --fragment: без <!doctype>/<html>/<head>/<body> — ровно то, что принимает Artifact-тул.
  if (args.fragment) {
    const headInner = html.slice(html.indexOf('<head>') + '<head>'.length, html.indexOf('</head>'));
    const bodyStart = html.indexOf('<body>') + '<body>'.length;
    // именно lastIndexOf: строка `</body>` встречается внутри вендоренного mermaid
    const bodyEnd = html.lastIndexOf('</body>');
    if (bodyStart < '<body>'.length || bodyEnd <= bodyStart) fail('Ошибка: не удалось вырезать фрагмент из шелла.');
    const head = headInner.split('\n').filter((l) => !/^\s*<meta\b/.test(l)).join('\n').trim();
    html = `${head}\n${html.slice(bodyStart, bodyEnd).trim()}\n`;
  }

  fs.writeFileSync(out, html);
  const kind = args.fragment ? 'фрагмент для Artifact (без doctype/html/body)' : 'самодостаточный HTML-файл';
  console.log(`Экспортировано: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB, read-only эксплорер, ${kind})`);
}

// ---------- main ----------

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

switch (command) {
  case 'serve': await cmdServe(args); break;
  case 'push': cmdPush(args); break;
  case 'await': await cmdAwait(args); break;
  case 'status': await cmdStatus(args); break;
  case 'export': cmdExport(args); break;
  default:
    fail(`Использование: node server.mjs <serve|push|await|status|export> --workdir <dir> [опции]\n` +
         `  serve --workdir <dir> [--port N] [--open]\n` +
         `  push <picker|review|explore> --workdir <dir>\n` +
         `  await --workdir <dir> [--stage X] [--timeout 540]\n` +
         `  status --workdir <dir>\n` +
         `  export --workdir <dir> [--out page.html] [--fragment]`);
}
