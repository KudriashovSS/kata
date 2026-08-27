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
    'site/site.json', 'site/facts.json', 'site/entities.json'];
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
    sendJson(res, 200, { state, payload });
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

function cmdPush(args) {
  const stage = args._[0];
  if (!STAGES.includes(stage)) {
    fail(`Ошибка: неизвестная стадия «${stage ?? ''}». Допустимые: ${STAGES.join(', ')}.`);
  }
  const workdir = requireWorkdir(args);

  const required = [STAGE_PAYLOAD[stage]];
  if (stage === 'explore') required.push('site/facts.json');
  for (const rel of required) {
    const abs = path.join(workdir, rel);
    if (!fs.existsSync(abs)) {
      fail(`Ошибка: файл payload не найден: ${abs}\nСтадия «${stage}» требует ${required.join(' и ')}.`);
    }
    try { readJsonFile(abs); } catch (e) {
      fail(`Ошибка: файл ${abs} не парсится как JSON: ${e.message}`);
    }
  }

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

async function cmdAwait(args) {
  const workdir = requireWorkdir(args);
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
      }
      pos = end; // не совпало по стадии — байты потребляем (но .ack сдвигаем только при находке)
    }
    return null;
  }

  while (true) {
    const found = scan(readAck());
    if (found) {
      fs.writeFileSync(ackFile, String(found.newOffset));
      console.log(found.line);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.log('{"timeout":true}');
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

  html = html
    .replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script src="./vendor/mermaid.min.js"></script>',
      () => `<script>window.TECHFACTS_EMBEDDED = ${embeddedJson};</script>\n<script>${mermaid}</script>`)
    .replace('<script type="module" src="./app.js"></script>', () => `<script type="module">\n${appJs}\n</script>`);

  fs.writeFileSync(out, html);
  console.log(`Экспортировано: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB, read-only эксплорер)`);
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
         `  export --workdir <dir> [--out page.html]`);
}
