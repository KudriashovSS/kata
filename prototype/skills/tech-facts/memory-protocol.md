# Протокол памяти

Модель данных не зависит от движка. Адаптеры: xmemory (первичный — из него читают агенты и
генерируются вьюверы для человека) и файловый (fallback, работает всегда). Скилл пишет и читает
только в терминах этой модели.

## Модель

### Entity — узел графа проекта

```json
{
  "id": "module:orders",
  "kind": "module | event | endpoint | table | external_system | flag",
  "name": "Orders",
  "attrs": { "path": "internal/orders" }
}
```

Гранулярность внутри модуля: когда субъект факта — конкретный компонент (хендлер, сервис), а не
модуль целиком, используй иерархический id (`module:application/manual-column-service`) или
`attrs.component` у факта. Иначе все produces/consumes-факты повиснут на одном модуле и граф
выродится.

### Fact — утверждение о связи или свойстве

```json
{
  "id": "fact:eg-0042",
  "type": "event-graph",
  "statement": "Orders публикует order.created при успешном создании заказа",
  "subject": "module:orders",
  "relation": "produces",
  "object": "event:order.created",
  "evidence": [
    { "kind": "code", "ref": "internal/orders/service.go:87" },
    { "kind": "commit", "ref": "abc1234" }
  ],
  "confidence": "high | medium | low",
  "status": "candidate | active | stale",
  "source": "extraction | task | human",
  "human_notes": ["Проверял вручную: у consumer-а Analytics обработчик отключён"],
  "superseded_by": null,
  "status_reason": null,
  "created_at": "2026-08-26T12:00:00Z"
}
```

Id факта несёт префикс среза (`eg` — event-graph, `mg` — module-graph, …) — параллельное
извлечение срезов не коллидирует по счётчикам. `human_notes` — комментарии человека из ревью;
они читаются агентами вместе с фактом и часто ценнее самого statement.

Свойства без второй сущности (инварианты, gotchas) — тот же Fact c `relation: "has_property"` и
`object: null`; суть в `statement` + evidence. Для config-flags субъектом такого факта естественно
выступает сама сущность флага:

```json
{ "id": "fact:cf-0003", "type": "config-flags", "subject": "flag:auth-enabled",
  "relation": "has_property", "object": null,
  "statement": "AuthOptions:Enabled выключен в dev; при выключенном флаге аудит-актор падает в System" }
```

### Жизненный цикл факта

```
extraction/task ──► candidate ──(человек подтвердил)──► active ──(код разошёлся / superseded / отклонён)──► stale
```

- **Читаются агентами только `active`.** candidate ждут человека, stale хранятся для истории.
- **Ничего не удаляется** — только смена статуса с обязательным `status_reason` и, если применимо,
  `superseded_by`. Это одновременно и «забывание/устаревание», и материал для разрешения
  противоречий.
- **Противоречия:** два факта об одном `(subject, relation, object)` с разными statement — побеждает
  тот, чей evidence свежее и подтверждён кодом сейчас (правило «код прав»); проигравший → `stale`
  со ссылкой на победителя. Конфликт, который нельзя решить кодом, эскалируется человеку.

### Журналы — observability

```json
{ "log": "memory_read",   "task": "issue-123", "facts": ["fact:eg-0042", "fact:go-0017"], "at": "..." }
{ "log": "memory_write",  "task": "issue-123", "created": ["fact:eg-0090"], "staled": ["fact:eg-0042"], "at": "..." }
{ "log": "memory_review", "task": "build-1", "approved": ["fact:eg-0042"], "rejected": ["fact:mg-0004"], "commented": ["fact:eg-0002"], "at": "..." }
```

В режиме строительства журнал начинается с memory_review/memory_write — memory_read появляется
только в режиме использования.

Журналы отвечают на вопросы демо и эвала: «какой факт в какую задачу попал», «какая задача породила
этот факт», «что изменилось в памяти после прогона». Без них дельту не доказать.

## Адаптер: xmemory (первичный)

1. Схему инстанса агент создаёт сам под выбранные срезы: типы сущностей = используемые `kind`,
   типы связей = используемые `relation`, Fact — объект со ссылками на subject/object и evidence.
   Не сваливать всё в один тип «текстовая заметка» — реляционность и есть смысл.
   **Стабильные ключи обязательны**: `fact_id` и `entry_id` — первичные ключи соответствующих
   объектов. `xmd generate` сам их не даёт — проверь сгенерированную схему и допиши
   (`xmd enhance` / руками), иначе ломается всё, что на них держится: перезапись статуса по id,
   `superseded_by`, журналы; повторное извлечение создаст дубликаты вместо обновления.
2. Выбрали новый срез позже → агент расширяет схему (новые kind/relation), не ломая старую.
3. Журналы memory_read/memory_write — тоже сущности со связями на факты и задачи: цепочка
   «факт → чтение → задача → изменение памяти» должна доставаться обходом графа (критерий
   номинации: наглядный write → read цикл).
4. Снапшоты для эвалов: отдельный инстанс/неймспейс на каждую конфигурацию эксперимента.
5. Вьюверы для человека (страницы по образцу `references/viewer.html`) — витрина, генерируемая из
   xmemory по запросу («покажи event graph»), а не отдельная база: правки из ревью возвращаются
   в xmemory, страница перегенерируется.
6. **Журнальные записи ссылаются на факты только явными id.** Упоминание фактов описанием
   («заstale-ил четыре схлопнутых факта») порождает в xmemory пустые объекты-призраки: всё, что
   упомянуто текстом, экстрактор превращает в объект. Пиши `staled: [fact:mg-0001, …]` — никогда
   прозой.

### Готовое описание для `xmd generate`

Проверено на живом инстансе — воспроизводит модель протокола почти дословно (не забудь после
генерации проверить первичные ключи, п. 1):

```bash
$XMEMCLI xmd generate "Memory for reverse-engineered technical facts about a software project.
Objects:
- Entity: primary key entity_id (string, hierarchical ids allowed like 'module:application/manual-column-service');
  kind (one of: module, event, endpoint, table, external_system, flag); name; attrs (free-form).
- Fact: primary key fact_id (string with slice prefix, e.g. 'fact:eg-0042'); type (slice name);
  statement (single sentence, <=200 chars); relation (produces, consumes, owns, depends_on, calls, has_property);
  subject -> Entity (required); object -> Entity (optional); evidence (list of code refs 'file:line' or commit ids);
  confidence (high/medium/low); status (candidate/active/stale); source (extraction/task/human);
  human_notes (list of strings); superseded_by -> Fact (optional); status_reason; created_at.
- JournalEntry: primary key entry_id; log (memory_read/memory_write/memory_review); task (string); at (timestamp);
  explicit relations to Fact by fact_id: read_facts, created_facts, staled_facts, approved_facts,
  rejected_facts, commented_facts. Journal entries must reference facts only via these relations,
  never by textual description." -o schema.yml
$XMEMCLI xmd validate schema.yml
```

## Адаптер: файловый — fallback (`.tech-facts/` в корне репозитория)

```
.tech-facts/
  schema.json      # какие срезы включены, версия модели
  entities.jsonl   # по Entity на строку
  facts.jsonl      # по Fact на строку; правки статуса — перезапись строки по id
  journal.jsonl    # memory_read / memory_write / memory_review, append-only
```

Работает без инфраструктуры, диффы видны в git, память версионируется вместе с кодом (снапшот
памяти = коммит — удобно для эвалов). Ограничение: выборка связями — грепом, на больших базах
деградирует. При появлении xmemory-инстанса содержимое мигрируется в него один-в-один.

## Правила объёма

- В контекст задачи попадает 5–20 релевантных active-фактов, отобранных по связям затронутых
  сущностей, а не вся база.
- statement — одно предложение, ≤ 200 символов. Детали живут в evidence, а не в тексте факта.
- Дифф памяти на подтверждение человеку — списком из ≤ 10 строк вида
  `+ fact:0090 (event-graph): ...` / `~ fact:0042 → stale: superseded by fact:0090`.
