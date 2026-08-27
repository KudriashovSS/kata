/* tech-facts UI shell — vanilla ES module, без сборки.
   Стадии: picker → review → explore (+ idle). Данные приходят от сервера скилла. */

'use strict';

/* ============================== Утилиты ============================== */

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** h('div', {class:'x', onclick: fn, 'aria-checked':'true'}, child, 'text', …) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

/* Иконки — inline SVG, Lucide-стиль (stroke 1.75). Никаких эмодзи. */
const ICONS = {
  home: '<path d="m3 10 9-7 9 7"/><path d="M5 8.5V21h14V8.5"/>',
  graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  events: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  api: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M6 8h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  table: '<path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9h18"/><path d="M9 9v12"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  zoom: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
};

function icon(name, size = 16, cls = '') {
  const inner = ICONS[name] || ICONS.dot;
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${inner}</svg>`;
  return tpl.content.firstChild;
}

function starIcon(on) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" class="${on ? 'on' : 'off'}" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7.18 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  return tpl.content.firstChild;
}

async function copyText(text, anchorEl) {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  if (anchorEl) {
    const tip = h('span', { class: 'copied-tip' }, ok ? 'скопировано' : 'не удалось');
    anchorEl.style.position = anchorEl.style.position || 'relative';
    anchorEl.append(tip);
    setTimeout(() => tip.remove(), 1200);
  }
  return ok;
}

function fmtDate(iso) {
  try {
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  } catch { return iso; }
}

/* ============================== Тема ============================== */

const THEME_KEY = 'techfacts-theme';
const THEMES = ['system', 'light', 'dark'];
const THEME_META = {
  system: { icon: 'monitor', label: 'Система' },
  light: { icon: 'sun', label: 'Светлая' },
  dark: { icon: 'moon', label: 'Тёмная' },
};

function getTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : 'system';
  } catch { return 'system'; }
}

function effectiveTheme() {
  const t = getTheme();
  if (t !== 'system') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const meta = THEME_META[t];
  $('#theme-icon').replaceChildren(icon(meta.icon, 15));
  $('#theme-label').textContent = meta.label;
  $('#theme-toggle').setAttribute('aria-label', `Тема: ${meta.label}. Переключить`);
  initMermaid();
  rerenderAllDiagrams();
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ок */ }
  applyTheme(next);
}

/* ============================== Mermaid ============================== */

/* Токены дизайн-системы в hex — khroma внутри mermaid не понимает oklch. */
const MM_COLORS = {
  light: {
    surface: '#fbfcfd', soft: '#eef1f5', border: '#d6dae0', text: '#1e2126',
    muted: '#5a6472', primary: '#2456c4', accent: '#0b9274',
  },
  dark: {
    surface: '#17191e', soft: '#23262c', border: '#3a3e46', text: '#d9dce0',
    muted: '#9aa3b0', primary: '#6aa4f8', accent: '#3fcfa4',
  },
};

let mmSeq = 0;
let diagrams = []; // {code, body} — живые диаграммы текущего рендера

function initMermaid() {
  if (!window.mermaid) return;
  const c = MM_COLORS[effectiveTheme()];
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: 'Inter, -apple-system, Segoe UI, Roboto, sans-serif',
    themeVariables: {
      background: c.surface,
      primaryColor: c.soft,
      primaryTextColor: c.text,
      primaryBorderColor: c.border,
      secondaryColor: c.soft,
      secondaryTextColor: c.text,
      secondaryBorderColor: c.border,
      tertiaryColor: c.surface,
      tertiaryTextColor: c.text,
      tertiaryBorderColor: c.border,
      lineColor: c.muted,
      textColor: c.text,
      mainBkg: c.soft,
      nodeBorder: c.border,
      clusterBkg: c.surface,
      clusterBorder: c.border,
      edgeLabelBackground: c.surface,
      titleColor: c.text,
      fontSize: '13px',
    },
  });
}

async function drawDiagram(body, code) {
  if (!window.mermaid) {
    body.replaceChildren(h('pre', { class: 'diagram-error' }, code));
    return;
  }
  try {
    const { svg } = await window.mermaid.render(`mmd-${++mmSeq}`, code);
    body.innerHTML = svg;
    body.classList.remove('diagram-error');
  } catch (e) {
    body.classList.add('diagram-error');
    body.textContent = `Диаграмма не отрисовалась: ${e.message || e}\n\n${code}`;
  }
}

function rerenderAllDiagrams() {
  diagrams = diagrams.filter(d => d.body.isConnected);
  for (const d of diagrams) drawDiagram(d.body, d.code);
}

function diagramCard(title, code) {
  const body = h('div', { class: 'diagram-body', role: 'img', 'aria-label': title || 'Диаграмма' });
  const card = h('div', { class: 'card diagram-card anim-in' },
    h('div', { class: 'diagram-head' },
      h('h3', { class: 'section-title' }, title || 'Диаграмма'),
      h('button', {
        class: 'btn btn-ghost btn-sm', 'aria-label': 'Копировать mermaid-код',
        onclick: e => { e.stopPropagation(); copyText(code, e.currentTarget); },
      }, icon('copy', 14), 'копировать mermaid'),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Открыть диаграмму крупнее',
        onclick: e => { e.stopPropagation(); openDiagramOverlay(title, body); },
      }, icon('zoom', 15)),
    ),
    body,
  );
  body.addEventListener('click', () => {
    if (!body.classList.contains('diagram-error')) openDiagramOverlay(title, body);
  });
  drawDiagram(body, code);
  diagrams.push({ code, body });
  return card;
}

function openDiagramOverlay(title, sourceBody) {
  const svg = sourceBody.querySelector('svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.removeAttribute('width');
  clone.style.maxWidth = 'none';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onclick: e => { if (e.target === overlay) close(); } },
    h('div', { class: 'overlay-panel', role: 'dialog', 'aria-label': title || 'Диаграмма' },
      h('div', { class: 'diagram-head' },
        h('h3', { class: 'section-title' }, title || 'Диаграмма'),
        h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onclick: close }, icon('x', 16)),
      ),
      h('div', { class: 'overlay-body' }, clone),
    ),
  );
  document.addEventListener('keydown', onKey);
  $('#overlay-root').append(overlay);
  overlay.querySelector('.icon-btn').focus();
}

/* ============================== Markdown ============================== */

function mdSafeUrl(u) {
  return /^(https?:\/\/|#|\.{0,2}\/|[\w./-]+$)/.test(u) && !/^javascript:/i.test(u);
}

function mdInline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => (mdSafeUrl(u) ? `<a href="${u}">${t}</a>` : `${t}`));
  return s;
}

/** Малый безопасный markdown: #..####, **b**, *i*, `code`, ```fences```, - списки, 1. списки, [ссылки], таблицы. */
function renderMarkdown(md) {
  const root = h('div', { class: 'block-md' });
  const fences = [];
  md = String(md).replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => {
    fences.push(code.replace(/\n$/, ''));
    return `\u0000F${fences.length - 1}\u0000`;
  });
  const lines = md.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    let m;
    if ((m = t.match(/^\u0000F(\d+)\u0000$/))) {
      html += `<pre><code>${esc(fences[+m[1]])}</code></pre>`;
      i++;
    } else if ((m = t.match(/^(#{1,4})\s+(.*)$/))) {
      const level = Math.min(m[1].length + 1, 4); // # → h2: page-title уже занят
      html += `<h${level}>${mdInline(m[2])}</h${level}>`;
      i++;
    } else if (t.startsWith('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      const cells = row => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(t);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { body.push(cells(lines[i].trim())); i++; }
      html += '<div class="md-table-wrap"><table><thead><tr>'
        + head.map(c => `<th>${mdInline(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>';
    } else if (/^[-*]\s+/.test(t)) {
      let items = '';
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items += `<li>${mdInline(lines[i].trim().replace(/^[-*]\s+/, ''))}</li>`;
        i++;
      }
      html += `<ul>${items}</ul>`;
    } else if (/^\d+\.\s+/.test(t)) {
      let items = '';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items += `<li>${mdInline(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`;
        i++;
      }
      html += `<ol>${items}</ol>`;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|\d+\.\s|\||\u0000)/.test(lines[i].trim())) {
        para.push(lines[i].trim());
        i++;
      }
      html += `<p>${mdInline(para.join(' '))}</p>`;
    }
  }
  root.innerHTML = html;
  return root;
}

/* ============================== API + SSE ============================== */

/* Embedded-режим: `server.mjs export` вшивает данные в страницу (артефакт/шаринг),
   сервера нет — читаем из window.TECHFACTS_EMBEDDED, решения не отправляются. */
const EMBEDDED = typeof window !== 'undefined' ? window.TECHFACTS_EMBEDDED : null;

async function fetchState() {
  if (EMBEDDED) return { state: EMBEDDED.state, payload: EMBEDDED.payload };
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

const fileCache = new Map(); // `${seq}:${name}` → Promise<json>
function fetchFile(name, seq) {
  if (EMBEDDED) {
    const short = name.replace(/^site\//, '');
    const data = (EMBEDDED.files || {})[name] ?? (EMBEDDED.files || {})[short];
    return data !== undefined ? Promise.resolve(data) : Promise.reject(new Error(`${name} нет в экспорте`));
  }
  const key = `${seq}:${name}`;
  if (!fileCache.has(key)) {
    fileCache.set(key, fetch(`/api/file/${name}`, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error(`${name} ${r.status}`);
      return r.json();
    }).catch(e => { fileCache.delete(key); throw e; }));
  }
  return fileCache.get(key);
}

async function postDecision(body) {
  if (EMBEDDED) throw new Error('Это read-only экспорт: решения принимаются в живом UI у агента');
  const res = await fetch('/api/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`decision ${res.status}`);
  return res.json().catch(() => ({}));
}

let sse = null;
let sseBackoff = 1000;
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/events');
  sse.addEventListener('state', () => refresh());
  sse.onopen = () => { sseBackoff = 1000; };
  sse.onerror = () => {
    sse.close();
    setTimeout(connectSSE, sseBackoff);
    sseBackoff = Math.min(sseBackoff * 2, 15000);
  };
}

/* ============================== Оркестрация ============================== */

const app = $('#app');
let renderedKey = null;           // `${stage}:${seq}` последнего рендера
const submittedKeys = new Set();  // формы, уже отправленные в этой сессии

const STAGE_LABELS = { picker: 'Выбор срезов', review: 'Ревью фактов', explore: 'Эксплорер', idle: 'Ожидание агента' };

function setHeader(stage, project, metaText) {
  $('#project-name').textContent = project || 'tech-facts';
  const ind = $('#stage-indicator');
  ind.hidden = false;
  ind.dataset.stage = stage;
  $('#stage-label').textContent = STAGE_LABELS[stage] || stage;
  $('#header-meta').textContent = metaText || '';
}

async function refresh(force = false) {
  let data;
  try {
    data = await fetchState();
  } catch {
    if (renderedKey !== 'idle') { renderedKey = 'idle'; renderIdle(); }
    return;
  }
  const state = data && data.state;
  if (!state || !state.stage) {
    if (renderedKey !== 'idle') { renderedKey = 'idle'; renderIdle(); }
    return;
  }
  const key = `${state.stage}:${state.seq}`;
  /* Та же стадия и тот же seq — не перерисовываем, чтобы не съесть ввод человека. */
  if (!force && key === renderedKey) return;
  renderedKey = key;
  diagrams = [];
  switch (state.stage) {
    case 'picker': renderPicker(state, data.payload, key); break;
    case 'review': renderReview(state, data.payload, key); break;
    case 'explore': renderExplore(state, data.payload, key); break;
    default: renderIdle();
  }
}

/* ============================== IDLE ============================== */

function renderIdle() {
  setHeader('idle', null, '');
  app.replaceChildren(
    h('div', { class: 'empty-state anim-in' },
      icon('graph', 36),
      h('h1', { class: 'page-title' }, 'Агент ещё не прислал данные'),
      h('p', {}, 'Как только агент запустит стадию, страница обновится сама.'),
    ),
  );
}

function sentState(title, note) {
  return h('div', { class: 'sent-state anim-in' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h1', { class: 'page-title' }, title),
    h('p', {}, note),
  );
}

/* ============================== Общие куски фактов ============================== */

const FACT_KNOWN_KEYS = new Set(['id', 'statement', 'evidence', 'confidence', 'status', 'auto_approved', 'question', 'human_notes', 'type', 'status_reason']);
const CONF_META = {
  high: { dots: '●●●', label: 'высокая' },
  medium: { dots: '●●○', label: 'средняя' },
  low: { dots: '●○○', label: 'низкая' },
};
const STATUS_META = {
  active: { label: 'подтверждён', cls: 'badge-active' },
  auto: { label: 'авто', cls: 'badge-auto' },
  candidate: { label: 'кандидат', cls: 'badge-candidate' },
  stale: { label: 'устарел', cls: 'badge-stale' },
  rejected: { label: 'отклонён', cls: 'badge-rejected' },
};

function confidenceEl(conf) {
  const meta = CONF_META[conf];
  if (!meta) return null;
  return h('span', { class: `conf conf-${conf}` },
    h('span', { class: 'dots', 'aria-hidden': 'true' }, meta.dots),
    `уверенность: ${meta.label}`,
  );
}

function statusBadge(status) {
  const meta = STATUS_META[status] || { label: status, cls: 'badge-neutral' };
  return h('span', { class: `badge ${meta.cls}` }, meta.label);
}

function evidenceChips(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return null;
  return h('div', { class: 'fact-evidence' },
    evidence.map(ev => {
      const ref = typeof ev === 'string' ? ev : (ev.ref || JSON.stringify(ev));
      return h('button', {
        class: 'evidence-chip', 'aria-label': `Копировать путь ${ref}`,
        onclick: e => copyText(ref, e.currentTarget),
      }, icon('copy', 11), h('span', { class: 'ref' }, ref));
    }),
  );
}

function extraFieldsDetails(fact) {
  const extra = Object.entries(fact).filter(([k, v]) => !FACT_KNOWN_KEYS.has(k) && v != null);
  if (!extra.length) return null;
  return h('details', { class: 'fact-details' },
    h('summary', {}, icon('chevron', 12, 'chev'), 'детали'),
    h('div', { class: 'kv-table' },
      extra.map(([k, v]) => [
        h('span', { class: 'k' }, k),
        h('span', { class: 'v' }, typeof v === 'string' ? v : JSON.stringify(v)),
      ]),
    ),
  );
}

function humanNotesEl(notes) {
  if (!notes) return null;
  const list = Array.isArray(notes) ? notes : [notes];
  return list.map(n => h('blockquote', { class: 'human-note', style: 'margin:0' },
    h('span', { class: 'n-label' }, 'заметка человека'),
    String(n),
  ));
}

/** Read-only карточка факта (explore). */
function factCard(fact) {
  const card = h('article', { class: 'card fact-card anim-in', dataset: { factId: fact.id || '' } },
    h('div', { class: 'fact-head' },
      h('p', { class: 'fact-statement' }, fact.statement || '—'),
      statusBadge(fact.status || 'candidate'),
    ),
    fact.status_reason ? h('p', { class: 'status-reason' }, fact.status_reason) : null,
    h('div', { class: 'fact-meta' },
      confidenceEl(fact.confidence),
      fact.id ? h('span', { class: 'fact-id' }, fact.id) : null,
    ),
    evidenceChips(fact.evidence),
    humanNotesEl(fact.human_notes),
    extraFieldsDetails(fact),
  );
  return card;
}

/* ============================== PICKER ============================== */

function renderPicker(state, payload, key) {
  setHeader('picker', payload.project, '');
  if (submittedKeys.has(key)) {
    app.replaceChildren(h('div', { class: 'stage-wrap' },
      sentState('Выбор улетел агенту — он приступил к извлечению',
        'Когда первая порция фактов будет готова, здесь откроется ревью.')));
    return;
  }

  const selected = new Set(payload.slices.filter(s => s.recommended).map(s => s.id));
  const form = { autoApprove: payload.auto_approve === 'high' ? 'high' : 'none', comment: '' };

  const countEl = h('span', { class: 'action-count tnum' });
  const updateCount = () => {
    countEl.textContent = `${selected.size} выбрано`;
    submitBtn.disabled = selected.size === 0;
  };

  const cards = payload.slices.map(slice => {
    const checked = selected.has(slice.id);
    const card = h('div', {
      class: 'card slice-card anim-in',
      role: 'checkbox', tabindex: '0',
      'aria-checked': String(checked),
      'aria-label': `Срез: ${slice.title}`,
    },
      h('div', { class: 'slice-top' },
        h('span', { class: 'slice-check', 'aria-hidden': 'true' }, icon('check', 13)),
        h('h3', { class: 'slice-title' }, slice.title),
        h('span', { class: `cost-badge cost-${esc(slice.cost || '')}` }, slice.cost || '?'),
      ),
      h('div', { class: 'stars-row' },
        h('span', { class: 'stars', role: 'img', 'aria-label': `Автоматизируемость: ${slice.stars} из 5` },
          [1, 2, 3, 4, 5].map(n => starIcon(n <= slice.stars))),
        h('span', { class: 'auto-note' }, slice.auto_note || ''),
      ),
      slice.found ? h('div', { class: 'slice-found' }, h('span', { class: 'k' }, 'Что нашла разведка'), slice.found) : null,
      slice.value ? h('div', { class: 'slice-value' }, h('span', { class: 'k' }, 'Зачем это агенту'), slice.value) : null,
      h('div', { class: 'slice-chips' },
        slice.recommended ? h('span', { class: 'badge badge-primary' }, 'рекомендовано') : null,
        (slice.stars <= 2) ? h('span', { class: 'badge badge-warn' }, 'гипотеза — потребует валидации') : null,
      ),
    );
    const toggle = () => {
      const now = !selected.has(slice.id);
      if (now) selected.add(slice.id); else selected.delete(slice.id);
      card.setAttribute('aria-checked', String(now));
      updateCount();
    };
    card.addEventListener('click', e => {
      if (e.target.closest('button, a, textarea, details')) return;
      toggle();
    });
    card.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });
    return card;
  });

  const submitBtn = h('button', {
    class: 'btn btn-primary',
    onclick: async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Отправляем…';
      try {
        await postDecision({
          stage: 'picker', type: 'picker',
          data: { selected: [...selected], auto_approve: form.autoApprove, comment: form.comment.trim() },
        });
        submittedKeys.add(key);
        renderPicker(state, payload, key);
      } catch (err) {
        btn.disabled = false;
        btn.replaceChildren(icon('send', 14), 'Отправить агенту');
        alert(`Не удалось отправить: ${err.message}. Сервер агента жив?`);
      }
    },
  }, icon('send', 14), 'Отправить агенту');

  app.replaceChildren(
    h('div', { class: 'stage-wrap' },
      h('div', { class: 'stage-head anim-in' },
        h('h1', { class: 'page-title' }, 'Какие срезы извлекать?'),
        h('p', { class: 'lede' }, payload.intro || ''),
      ),
      h('div', { class: 'slice-grid' }, cards),
    ),
    h('div', { class: 'action-bar' },
      h('div', { class: 'action-bar-inner' },
        countEl,
        h('label', { class: 'action-field' }, 'авто-подтверждение',
          h('select', {
            'aria-label': 'Режим авто-подтверждения',
            onchange: e => { form.autoApprove = e.target.value; },
          },
            h('option', { value: 'high', selected: form.autoApprove === 'high' }, 'high → авто'),
            h('option', { value: 'none', selected: form.autoApprove === 'none' }, 'всё вручную'),
          ),
        ),
        h('div', { class: 'grow' },
          h('textarea', {
            rows: '1', placeholder: 'Комментарий агенту (необязательно)',
            'aria-label': 'Комментарий агенту',
            oninput: e => { form.comment = e.target.value; },
          }),
        ),
        submitBtn,
      ),
    ),
  );
  updateCount();
}

/* ============================== REVIEW ============================== */

function renderReview(state, payload, key) {
  setHeader('review', payload.project, '');
  if (submittedKeys.has(key)) {
    app.replaceChildren(h('div', { class: 'stage-wrap' },
      sentState('Ревью улетело агенту',
        'Агент разбирает ваши решения. Следующая порция или сайт появятся здесь.')));
    return;
  }

  const facts = payload.facts || [];
  const decisions = new Map(); // id → {action, comment}
  let globalComment = '';

  const autoFacts = facts.filter(f => f.auto_approved);
  const needsAnswer = facts.filter(f => !f.auto_approved && (f.question || f.confidence === 'low'));
  const plain = facts.filter(f => !f.auto_approved && !needsAnswer.includes(f));
  const manual = [...needsAnswer, ...plain];

  const progressEls = [];
  function decidedCount() {
    let n = 0;
    for (const f of manual) {
      const d = decisions.get(f.id);
      if (d && (d.action === 'approve' || d.action === 'reject')) n++;
    }
    return n;
  }
  function updateProgress() {
    const text = `решено из ${manual.length}`;
    for (const el of progressEls) {
      el.replaceChildren(h('b', {}, String(decidedCount())), ` ${text}`);
    }
  }
  function progressEl() {
    const el = h('span', { class: 'review-progress' });
    progressEls.push(el);
    return el;
  }

  function buildDecisionPayload() {
    const out = {};
    for (const [id, d] of decisions) {
      if (!d.action && !(d.comment && d.comment.trim())) continue;
      const entry = {};
      if (d.action) entry.action = d.action;
      if (d.comment && d.comment.trim()) entry.comment = d.comment.trim();
      if (!entry.action) entry.action = 'skip'; // только комментарий — фиксируем как skip с комментарием
      out[id] = entry;
    }
    return {
      stage: 'review', type: 'review',
      data: { batch: payload.batch, decisions: out, global_comment: globalComment.trim() },
    };
  }

  /** Карточка ручного ревью. */
  function reviewCard(fact, prominent) {
    const badgeSlot = h('span', {});
    const card = h('article', { class: `card fact-card anim-in${prominent ? ' needs-answer' : ''}`, dataset: { factId: fact.id } },
      h('div', { class: 'fact-head' },
        h('p', { class: 'fact-statement' }, fact.statement || '—'),
        badgeSlot,
      ),
      fact.question ? h('div', { class: 'fact-question' },
        h('span', { class: 'q-label' }, 'вопрос агента'), fact.question) : null,
      h('div', { class: 'fact-meta' },
        confidenceEl(fact.confidence),
        h('span', { class: 'fact-id' }, fact.id),
      ),
      evidenceChips(fact.evidence),
      extraFieldsDetails(fact),
    );

    const commentTa = h('textarea', {
      class: 'fact-comment-box', rows: '2', placeholder: 'Комментарий к решению — агент его прочитает',
      'aria-label': `Комментарий к факту ${fact.id}`, hidden: true,
      oninput: e => {
        const d = decisions.get(fact.id) || {};
        d.comment = e.target.value;
        decisions.set(fact.id, d);
      },
    });

    const approveBtn = h('button', { class: 'btn btn-sm btn-approve' }, icon('check', 13), 'Принять');
    const rejectBtn = h('button', { class: 'btn btn-sm btn-reject' }, icon('x', 13), 'Отклонить');
    const commentBtn = h('button', {
      class: 'btn btn-sm btn-ghost', 'aria-label': `Комментировать факт ${fact.id}`,
      onclick: () => {
        commentTa.hidden = !commentTa.hidden;
        if (!commentTa.hidden) commentTa.focus();
      },
    }, icon('comment', 13), 'комментарий');

    function setAction(action) {
      const d = decisions.get(fact.id) || {};
      d.action = d.action === action ? null : action; // повторный клик снимает решение
      decisions.set(fact.id, d);
      sync();
      updateProgress();
    }
    approveBtn.addEventListener('click', () => setAction('approve'));
    rejectBtn.addEventListener('click', () => setAction('reject'));

    function sync() {
      const d = decisions.get(fact.id) || {};
      card.classList.toggle('decided-approve', d.action === 'approve');
      card.classList.toggle('decided-reject', d.action === 'reject');
      approveBtn.classList.toggle('on', d.action === 'approve');
      rejectBtn.classList.toggle('on', d.action === 'reject');
      badgeSlot.replaceChildren(
        d.action === 'approve' ? h('span', { class: 'badge badge-active' }, 'принято')
          : d.action === 'reject' ? h('span', { class: 'badge badge-rejected' }, 'отклонено')
            : statusBadge(fact.status || 'candidate'),
      );
    }
    sync();

    card.append(h('div', { class: 'fact-actions' }, approveBtn, rejectBtn, commentBtn), commentTa);
    return card;
  }

  /** Карточка авто-подтверждённого факта. */
  function autoCard(fact) {
    const badgeSlot = h('span', {});
    const revokeBtn = h('button', { class: 'btn btn-sm btn-ghost', 'aria-label': `Отозвать авто-подтверждение факта ${fact.id}` });
    const card = h('article', { class: 'card fact-card', dataset: { factId: fact.id } },
      h('div', { class: 'fact-head' },
        h('p', { class: 'fact-statement' }, fact.statement || '—'),
        badgeSlot,
      ),
      h('div', { class: 'fact-meta' },
        confidenceEl(fact.confidence),
        h('span', { class: 'fact-id' }, fact.id),
      ),
      evidenceChips(fact.evidence),
      extraFieldsDetails(fact),
      h('div', { class: 'fact-actions' }, revokeBtn),
    );
    function sync() {
      const revoked = decisions.get(fact.id)?.action === 'unapprove';
      card.classList.toggle('revoked', revoked);
      badgeSlot.replaceChildren(revoked
        ? h('span', { class: 'badge badge-candidate' }, 'отозвано → кандидат')
        : h('span', { class: 'badge badge-auto' }, 'авто-подтверждён'));
      revokeBtn.replaceChildren(icon('undo', 13), revoked ? 'вернуть авто-подтверждение' : 'отозвать');
    }
    revokeBtn.addEventListener('click', () => {
      const d = decisions.get(fact.id) || {};
      d.action = d.action === 'unapprove' ? null : 'unapprove';
      decisions.set(fact.id, d);
      sync();
    });
    sync();
    return card;
  }

  const submitBtn = h('button', {
    class: 'btn btn-primary',
    onclick: async e => {
      const undecided = manual.length - decidedCount();
      if (undecided > 0) {
        const ok = confirm(`Без решения осталось фактов: ${undecided}. Они останутся кандидатами. Отправить ревью?`);
        if (!ok) return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Отправляем…';
      try {
        await postDecision(buildDecisionPayload());
        submittedKeys.add(key);
        renderReview(state, payload, key);
      } catch (err) {
        btn.disabled = false;
        btn.replaceChildren(icon('send', 14), 'Отправить ревью');
        alert(`Не удалось отправить: ${err.message}. Фоллбек — кнопка «Скопировать ревью JSON».`);
      }
    },
  }, icon('send', 14), 'Отправить ревью');

  app.replaceChildren(
    h('div', { class: 'stage-wrap' },
      h('div', { class: 'stage-head anim-in' },
        h('div', { style: 'display:flex; align-items:baseline; gap:14px; flex-wrap:wrap;' },
          h('h1', { class: 'page-title' }, payload.title || `Ревью: ${payload.batch}`),
          progressEl(),
        ),
        payload.note ? h('p', { class: 'lede' }, payload.note) : null,
      ),
      payload.diagram?.mermaid ? diagramCard('Диаграмма среза', payload.diagram.mermaid) : null,

      needsAnswer.length ? h('section', { class: 'section-gap needs-answer-section' },
        h('h2', { class: 'review-section-title' }, icon('alert', 16), 'Нужен ваш ответ',
          h('span', { class: 'count' }, String(needsAnswer.length))),
        h('div', { class: 'fact-list' }, needsAnswer.map(f => reviewCard(f, true))),
      ) : null,

      plain.length ? h('section', { class: 'section-gap' },
        h('h2', { class: 'review-section-title' }, 'Ждут решения',
          h('span', { class: 'count' }, String(plain.length))),
        h('div', { class: 'fact-list' }, plain.map(f => reviewCard(f, false))),
      ) : null,

      autoFacts.length ? h('details', { class: 'auto-section section-gap' },
        h('summary', {},
          icon('chevron', 14, 'chev'),
          h('span', {}, `Авто-подтверждено (${autoFacts.length})`),
          h('span', { class: 'badge badge-auto' }, icon('check', 11), 'high + evidence'),
        ),
        h('div', { class: 'fact-list' }, autoFacts.map(autoCard)),
      ) : null,
    ),
    h('div', { class: 'action-bar' },
      h('div', { class: 'action-bar-inner' },
        progressEl(),
        h('div', { class: 'grow' },
          h('textarea', {
            rows: '1', placeholder: 'Общий комментарий к порции (необязательно)',
            'aria-label': 'Общий комментарий к ревью',
            oninput: e => { globalComment = e.target.value; },
          }),
        ),
        h('button', {
          class: 'btn btn-ghost btn-sm', 'aria-label': 'Скопировать ревью в формате JSON — фоллбек, если агент не отвечает',
          onclick: e => copyText(JSON.stringify(buildDecisionPayload(), null, 2), e.currentTarget),
        }, icon('copy', 13), 'Скопировать ревью JSON'),
        submitBtn,
      ),
    ),
  );
  updateProgress();
}

/* ============================== EXPLORE ============================== */

const PAGE_ICONS = new Set(['home', 'graph', 'events', 'database', 'api', 'plug', 'shield', 'flag', 'alert', 'table', 'book']);
const STATUS_FILTERS = ['active', 'auto', 'candidate', 'stale'];

let exploreCtx = null;

function matchesFilter(fact, filter) {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    const wanted = Array.isArray(v) ? v : [v];
    const have = Array.isArray(fact[k]) ? fact[k] : [fact[k]];
    if (!wanted.some(w => have.includes(w))) return false;
  }
  return true;
}

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!raw) return { pageId: null, factId: null };
  const slash = raw.indexOf('/');
  if (slash === -1) return { pageId: raw, factId: null };
  return { pageId: raw.slice(0, slash), factId: raw.slice(slash + 1) || null };
}

window.addEventListener('hashchange', () => {
  if (exploreCtx && renderedKey === exploreCtx.key) renderExplorePage();
});

async function renderExplore(state, site, key) {
  setHeader('explore', site.project, site.generated_at ? `данные от ${fmtDate(site.generated_at)}` : '');

  let facts = [];
  try {
    facts = await fetchFile('facts.json', state.seq);
    if (!Array.isArray(facts)) facts = [];
  } catch { facts = []; }
  if (renderedKey !== key) return; // пока грузили — стадия сменилась

  exploreCtx = { key, site, facts, statusFilter: new Set() };

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-project' },
      h('div', { class: 'name' }, site.project || 'проект'),
      site.generated_at ? h('div', { class: 'meta' }, `данные от ${fmtDate(site.generated_at)}`) : null,
    ),
    buildSearchBox(),
    h('nav', { 'aria-label': 'Страницы' },
      h('div', { class: 'sidebar-label' }, 'Страницы'),
      h('div', { class: 'nav-list' },
        (site.pages || []).map(p => h('button', {
          class: 'nav-item', dataset: { pageId: p.id },
          onclick: () => { location.hash = encodeURIComponent(p.id); },
        }, icon(PAGE_ICONS.has(p.icon) ? p.icon : 'dot', 16), p.title || p.id)),
      ),
    ),
    h('div', {},
      h('div', { class: 'sidebar-label' }, 'Статус фактов'),
      h('div', { class: 'filter-chips' },
        STATUS_FILTERS.map(s => h('button', {
          class: 'chip', dataset: { status: s }, 'aria-pressed': 'false',
          onclick: e => {
            const on = exploreCtx.statusFilter.has(s);
            if (on) exploreCtx.statusFilter.delete(s); else exploreCtx.statusFilter.add(s);
            e.currentTarget.classList.toggle('on', !on);
            e.currentTarget.setAttribute('aria-pressed', String(!on));
            renderExplorePage();
          },
        }, (STATUS_META[s] || {}).label || s)),
      ),
    ),
  );

  const mobileSelect = h('select', {
    'aria-label': 'Страница',
    onchange: e => { location.hash = encodeURIComponent(e.target.value); },
  }, (site.pages || []).map(p => h('option', { value: p.id }, p.title || p.id)));

  const content = h('div', { class: 'explore-content' }, h('div', { class: 'explore-page' }));

  exploreCtx.sidebar = sidebar;
  exploreCtx.content = content;
  exploreCtx.mobileSelect = mobileSelect;

  app.replaceChildren(
    h('div', { class: 'explore-layout' },
      sidebar,
      h('div', { style: 'flex:1; min-width:0; display:flex; flex-direction:column;' },
        h('div', { class: 'mobile-nav' }, mobileSelect),
        content,
      ),
    ),
  );
  renderExplorePage();
}

function buildSearchBox() {
  const results = h('div', { class: 'search-results', hidden: true, role: 'listbox' });
  const input = h('input', {
    type: 'search', placeholder: 'Поиск по фактам…', 'aria-label': 'Поиск по фактам',
  });
  let debounce = 0;

  function factHaystack(f) {
    const parts = [];
    for (const [k, v] of Object.entries(f)) {
      if (typeof v === 'string') parts.push(v);
      else if (Array.isArray(v)) for (const x of v) {
        if (typeof x === 'string') parts.push(x);
        else if (x && typeof x.ref === 'string') parts.push(x.ref);
      }
    }
    return parts.join(' ').toLowerCase();
  }

  function runSearch() {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.hidden = true; results.replaceChildren(); return; }
    const found = exploreCtx.facts.filter(f => factHaystack(f).includes(q)).slice(0, 12);
    results.hidden = false;
    if (!found.length) {
      results.replaceChildren(h('div', { class: 'search-empty' }, 'Ничего не нашлось'));
      return;
    }
    results.replaceChildren(...found.map(f => h('button', {
      class: 'search-result', role: 'option',
      onclick: () => { results.hidden = true; input.value = ''; gotoFact(f); },
    },
      h('div', { class: 's-statement' }, f.statement || f.id),
      h('div', { class: 's-meta' }, statusBadge(f.status || 'candidate'), h('span', { class: 'fact-id' }, f.id)),
    )));
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 120);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { results.hidden = true; input.blur(); }
    if (e.key === 'Enter') {
      const first = results.querySelector('.search-result');
      if (first) first.click();
    }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search-box')) results.hidden = true;
  });

  return h('div', { class: 'search-box' },
    h('div', { class: 'search-input-wrap' }, icon('search', 14), input),
    results,
  );
}

function pageForFact(fact) {
  const pages = exploreCtx.site.pages || [];
  for (const p of pages) {
    for (const b of p.blocks || []) {
      if (b.type === 'facts' && matchesFilter(fact, b.filter)) return p.id;
    }
  }
  return pages[0]?.id || null;
}

function gotoFact(fact) {
  const pageId = pageForFact(fact);
  if (!pageId) return;
  const target = `${encodeURIComponent(pageId)}/${encodeURIComponent(fact.id)}`;
  if (location.hash === `#${target}`) renderExplorePage();
  else location.hash = target;
}

function renderExplorePage() {
  const ctx = exploreCtx;
  if (!ctx) return;
  const pages = ctx.site.pages || [];
  let { pageId, factId } = parseHash();
  let page = pages.find(p => p.id === pageId);
  if (!page) { page = pages[0]; factId = null; }
  if (!page) {
    ctx.content.replaceChildren(h('div', { class: 'empty-state' }, h('p', {}, 'В site.json нет страниц.')));
    return;
  }

  for (const btn of ctx.sidebar.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.pageId === page.id);
    if (btn.dataset.pageId === page.id) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  ctx.mobileSelect.value = page.id;

  diagrams = [];
  const wrap = h('div', { class: 'explore-page' });
  for (const block of page.blocks || []) wrap.append(renderBlock(block));
  ctx.content.replaceChildren(wrap);

  if (factId) {
    const el = wrap.querySelector(`[data-fact-id="${CSS.escape(factId)}"]`);
    if (el) {
      el.classList.add('highlight');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => el.classList.remove('highlight'), 2400);
    }
  } else {
    ctx.content.closest('.explore-layout')?.scrollIntoView?.();
    window.scrollTo({ top: 0 });
  }
}

function renderBlock(block) {
  switch (block.type) {
    case 'markdown': {
      const el = renderMarkdown(block.md || '');
      el.classList.add('anim-in');
      return el;
    }
    case 'stats':
      return h('div', { class: 'stats-row anim-in' },
        (block.items || []).map(it => h('div', { class: 'card stat-tile' },
          h('div', { class: 'stat-value' }, String(it.value)),
          h('div', { class: 'stat-label' }, it.label || ''),
        )),
      );
    case 'mermaid':
      return diagramCard(block.title, block.code || '');
    case 'table':
      return tableBlock(block);
    case 'facts':
      return factsBlock(block);
    case 'html': {
      /* Контент от агента — доверенный по контракту; вставляем как есть в обёртке. */
      const el = h('div', { class: 'block-html anim-in' });
      el.innerHTML = block.html || '';
      return el;
    }
    default:
      return h('div', { class: 'card anim-in' },
        h('p', { class: 'meta' }, `Неизвестный блок «${block.type}»`),
        h('pre', { class: 'mono', style: 'overflow-x:auto; margin:8px 0 0;' }, JSON.stringify(block, null, 2)),
      );
  }
}

function looksLikeCode(s) {
  return typeof s === 'string' && s !== '—' && !/\s/.test(s) && /[/:.]/.test(s);
}

function tableBlock(block) {
  return h('div', { class: 'card block-table anim-in' },
    block.title ? h('h3', { class: 'section-title' }, block.title) : null,
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, (block.columns || []).map(c => h('th', {}, c)))),
        h('tbody', {}, (block.rows || []).map(row => h('tr', {},
          row.map(cell => h('td', looksLikeCode(cell) ? { class: 'mono' } : {}, String(cell))),
        ))),
      ),
    ),
  );
}

const GROUP_ORDER = ['active', 'auto', 'candidate', 'stale', 'rejected'];

function factsBlock(block) {
  const ctx = exploreCtx;
  let facts = ctx.facts.filter(f => matchesFilter(f, block.filter));
  if (ctx.statusFilter.size) facts = facts.filter(f => ctx.statusFilter.has(f.status));

  const wrap = h('section', { class: 'facts-block anim-in' },
    h('h3', { class: 'section-title' }, block.title || 'Факты',
      h('span', { class: 'count tnum' }, String(facts.length))),
  );

  if (!facts.length) {
    wrap.append(h('p', { class: 'facts-empty' }, 'Под фильтр не попал ни один факт.'));
    return wrap;
  }

  if (block.group_by) {
    const groups = new Map();
    for (const f of facts) {
      const v = f[block.group_by] == null ? '—' : String(f[block.group_by]);
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(f);
    }
    let keys = [...groups.keys()];
    if (block.group_by === 'status') {
      keys.sort((a, b) => {
        const ia = GROUP_ORDER.indexOf(a); const ib = GROUP_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
    } else keys.sort();
    for (const k of keys) {
      const label = block.group_by === 'status' ? ((STATUS_META[k] || {}).label || k) : k;
      wrap.append(
        h('div', { class: 'facts-group-label' }, `${block.group_by}: ${label}`,
          h('span', { class: 'tnum' }, `· ${groups.get(k).length}`)),
        h('div', { class: 'fact-list' }, groups.get(k).map(factCard)),
      );
    }
  } else {
    wrap.append(h('div', { class: 'fact-list' }, facts.map(factCard)));
  }
  return wrap;
}

/* ============================== Старт ============================== */

$('#theme-toggle').addEventListener('click', cycleTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'system') { initMermaid(); rerenderAllDiagrams(); }
});

applyTheme(getTheme());
refresh(true);
if (!EMBEDDED) connectSSE();
