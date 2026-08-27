# Протокол UI: сервер, стадии, форматы данных

UI — **одно приложение на одном порте** (default `4747`, env `TECHFACTS_PORT`). Агент не пишет
HTML: он кладёт JSON в рабочий каталог и переключает стадию; шелл (`ui/`) рендерит. Стадии
сменяются на одном URL: `picker` → `review` (порциями) → `explore`.

Обратная связь — **блокирующая**: агент запускает `await` и ждёт решения человека из браузера
(паттерн plannotator: сервер держит решение, агент забирает и продолжает).

## Рабочий каталог (workdir)

Всегда во временной директории, **не в репозитории пользователя** (источник истины — xmemory;
локальные файлы — только витрина и транспорт): `${TMPDIR}/tech-facts/<slug-проекта>/`.

```
workdir/
  state.json        # {"stage":"picker|review|explore","project":"...","seq":3,"updated_at":"..."}
  picker.json       # payload стадии picker
  review.json       # payload текущей порции ревью
  site/
    site.json       # конфиг сайта: страницы и блоки
    facts.json      # все факты (мини-ядро + свободные поля)
    entities.json   # опционально
  decisions.jsonl   # append-only: решения человека (пишет сервер)
  .ack              # курсор await (байтовое смещение прочитанного)
```

## CLI (`scripts/server.mjs`, zero-dep, Node ≥ 18)

```bash
node scripts/server.mjs serve --workdir <dir> [--port 4747] [--open]   # сервер, форграунд
node scripts/server.mjs push <stage> --workdir <dir>                   # переключить стадию
node scripts/server.mjs await --workdir <dir> [--stage review] [--timeout 540]
node scripts/server.mjs status --workdir <dir>                        # health/stage/URL, exit 1 если сервер не поднят
node scripts/server.mjs export --workdir <dir> [--out page.html]      # самодостаточный read-only эксплорер
```

- `serve` — агент запускает в бэкграунде один раз за сессию. Повторный запуск при живом сервере
  на том же workdir — мягкий exit 0 с подсказкой «уже работает». Порт занят чужим процессом —
  внятная ошибка с советом `TECHFACTS_PORT`.
- `push` — валидирует, что payload-файл стадии существует и парсится, инкрементит `seq`,
  обновляет `state.json`. Сервер замечает изменение (fs-watch + poll-фоллбек 1с) и шлёт SSE.
- `await` — блокируется до **новой** записи в `decisions.jsonl` (после `.ack`; фильтр по
  `--stage`), печатает её JSON в stdout, сдвигает `.ack`. Таймаут (default 540с — меньше
  лимита Bash-тула) → exit 3 и `{"timeout":true}`; агент просто перезапускает `await` —
  решение не теряется, курсор не сдвинут. Работает чисто по файлам: падение/рестарт сервера
  решений не теряет.
- `export` — собирает один HTML-файл: шелл + вшитые данные `site/` (стадия explore, read-only,
  без решений). Для публикации артефактом (Claude) или пересылки коллеге без сервера.

## HTTP API (сервер ↔ браузер)

- `GET /` и статика → `ui/` (шелл), `GET /api/health` → `{ok,stage,workdir}`.
- `GET /api/state` → `{state, payload}` (payload = содержимое файла текущей стадии;
  для `explore` — `site.json`).
- `GET /api/file/<name>` → JSON из workdir (`facts.json`, `entities.json`…). Только чтение,
  только внутри workdir.
- `GET /api/events` → SSE: событие `state` при любом изменении workdir (браузер перезапрашивает
  `/api/state`), `ping` каждые 25с.
- `POST /api/decision` `{stage,type,data}` → сервер добавляет `{seq,at}` и дописывает строку в
  `decisions.jsonl`. UI после отправки показывает состояние «улетело агенту» и блокирует
  повторную отправку той же формы (агент пришлёт следующую стадию).

## Payload стадий

### `picker.json` — лендинг выбора срезов

```json
{
  "project": "services-platform",
  "intro": "Contract-first .NET монолит, 5 модулей, in-process события, PostgreSQL.",
  "auto_approve": "high",
  "slices": [{
    "id": "event-graph",
    "title": "Граф событий",
    "stars": 4,
    "auto_note": "извлекается автоматически; семантика доставки — с валидацией",
    "cost": "S",
    "found": "14 in-process событий в internal/events/, брокера нет",
    "value": "Агент без этого среза забывает уведомить консюмеров",
    "recommended": true
  }]
}
```

`stars` (1–5) — автоматизируемость из fact-catalog, пересчитанная разведкой под этот репозиторий.
Карточки со `stars ≤ 2` шелл помечает «гипотеза — потребует вашей валидации».

Решение: `{"stage":"picker","type":"picker","data":{"selected":["event-graph"],"auto_approve":"high","comment":""}}`

### `review.json` — порция ревью (один срез за раз)

```json
{
  "project": "services-platform",
  "batch": "event-graph",
  "title": "Ревью: граф событий",
  "note": "12 фактов авто-подтверждены (high + evidence), 6 ждут решения",
  "diagram": {"mermaid": "flowchart LR\n  Orders -- produces --> order_created[order.created]"},
  "facts": [{
    "id": "fact:eg-0001",
    "statement": "Orders публикует order.created при успешном создании заказа",
    "evidence": [{"kind": "code", "ref": "internal/orders/service.go:87"}],
    "confidence": "high",
    "status": "candidate",
    "auto_approved": true,
    "question": null
  }]
}
```

Мини-ядро факта: `id`, `statement`, `evidence[]`, `confidence`, `status` (+ `auto_approved`,
`question`, `human_notes` понимает шелл). **Любые другие поля разрешены** — UI показывает их
в развороте карточки как есть; схему данных проектирует агент под проект.

UI-правило авто-подтверждения: `auto_approved: true` — свёрнутая секция «Авто-подтверждено ✓»
с кнопкой «отозвать» на каждом факте; остальные — карточки с Принять/Отклонить/Комментировать;
`question`/`confidence: low` — выделенная секция «Нужен ваш ответ» сверху.

Решение:
```json
{"stage":"review","type":"review","data":{
  "batch": "event-graph",
  "decisions": {"fact:eg-0002": {"action": "approve", "comment": "и уточни консюмера"}},
  "global_comment": ""
}}
```
`action`: `approve` | `reject` | `unapprove` (отзыв авто-подтверждения → назад в candidate) |
`skip`. Экспорт-кнопка «скопировать ревью JSON» остаётся как фоллбек, если агент умер.

### `site/site.json` — сайт-эксплорер (стадия `explore`)

Конструктор: страницы из блоков. Набор блоков — тулкит, не клетка: не хватает — блок `html`
с токенами из [design.md](design.md).

```json
{
  "project": "services-platform",
  "generated_at": "2026-08-27T12:00:00Z",
  "pages": [{
    "id": "overview", "title": "Обзор", "icon": "home",
    "blocks": [
      {"type": "markdown", "md": "## Что это за система\n..."},
      {"type": "stats", "items": [{"label": "Фактов", "value": 37}, {"label": "Активных", "value": 31}]},
      {"type": "mermaid", "title": "Модули и зависимости", "code": "flowchart LR\n A --> B"},
      {"type": "facts", "title": "Инварианты", "filter": {"type": "invariants", "status": ["active"]}, "group_by": "status"},
      {"type": "table", "title": "Флаги", "columns": ["Флаг", "Что переключает", "Evidence"], "rows": [["new_pricing", "v2-алгоритм", "pricing.go:42"]]},
      {"type": "html", "html": "<div class=\"card\">…</div>"}
    ]
  }]
}
```

Блок `facts` тянет из `facts.json` (фильтр по любым полям: точное значение или массив значений).
Шелл добавляет поверх: сайдбар-навигацию по страницам, глобальный поиск по фактам,
фильтр статусов, переключатель темы. Evidence `файл:строка` — моноширинно, клик копирует путь.

## Ответственность

- **Шелл** (в скилле, один раз): рендер стадий и блоков, темы, поиск, отправка решений.
- **Агент** (каждый проект): содержимое — какие срезы предлагать, какие страницы и блоки собрать,
  какие диаграммы нарисовать, что авто-подтвердить. Агент решает «что», шелл — «как выглядит».
