# Протокол памяти

Единственный источник истины о фактах — **xmemory**. Всё, что лежит в рабочем каталоге UI
(`/tmp/...`) — витрина и транспорт, оно одноразовое; правки фактов существуют только как записи
в памяти. Файловый адаптер `.tech-facts/` в репо — fallback исключительно когда xmemory
недоступен (при появлении — мигрируй и удали).

## Мини-ядро факта — единственное, что фиксировано

Схему памяти проектирует **агент под конкретный проект**, и она эволюционирует вместе с памятью.
Запрещено заранее решать за будущего агента, как хранить данные. Фиксирован только минимум, на
котором держатся ревью-цикл, авто-подтверждение и вьювер:

```json
{
  "id": "fact:eg-0042",
  "statement": "Orders публикует order.created при успешном создании заказа",
  "evidence": [{ "kind": "code", "ref": "internal/orders/service.go:87" }],
  "confidence": "high | medium | low",
  "status": "candidate | active | stale"
}
```

Рекомендуемые (шелл UI их понимает, агенты читают): `provenance` (`declared` — из декларативного
артефакта, `observed` — выведено из кода, `inferred` — интерпретация), `type` (срез), `subject`/
`relation`/`object` (реляционность — смысл памяти: связи «событие → владелец → таблица» дают
кратную пользу), `human_notes[]`, `question`, `source` (`extraction|task|human`), `superseded_by`,
`status_reason`, `auto_approved`, `created_at`. Всё остальное — свободные поля под проект:
`delivery: "sync"`, `env_diff`, что угодно. UI покажет их в деталях карточки как есть.

Id факта несёт префикс среза (`eg`, `mg`, …) — параллельное извлечение не коллидирует.
`statement` — одно предложение ≤ 200 символов; детали в evidence и свободных полях.
Факт без evidence не существует.

## Жизненный цикл и авто-подтверждение

```
extraction/task ──► candidate ──┬─(авто: high + declared/observed + evidence)──► active (auto_approved)
                                └─(человек в ревью)───────────────────────────► active | stale(rejected)
active ──(код разошёлся / superseded / отозван)──► stale
```

Агент **не таскает человека по каждому факту** — подтверждает сам то, в чём уверен:

- **Авто-approve**: `confidence: high` И `provenance: declared|observed` И есть code-evidence →
  `active` c `auto_approved: true`. В ревью такие факты показываются свёрнутой секцией
  «Авто-подтверждено» — человек может отозвать любой (`unapprove` → назад в candidate).
- **Никогда не авто-подтверждаются**: `inferred`-факты, весь срез gotchas, `medium|low`,
  факты с заполненным `question`, факты о границе видимости.
- Человеку на ревью едет только сомнительное; факты с `question`/`low` — секцией «Нужен ваш
  ответ» на самом верху.

Правила статусов: читаются агентами только `active`; ничего не удаляется — только смена статуса
с `status_reason` (+`superseded_by`); противоречие двух фактов об одном и том же решает код
(«код прав»), проигравший → `stale` со ссылкой на победителя; неразрешимое кодом — эскалация
человеку. Комментарии человека из ревью — в `human_notes`: они едут в контекст будущих агентов
вместе с фактом и часто ценнее самого statement.

## Журналы — observability

```json
{ "log": "memory_read",   "task": "issue-123", "facts": ["fact:eg-0042"], "at": "..." }
{ "log": "memory_write",  "task": "issue-123", "created": ["fact:eg-0090"], "staled": ["fact:eg-0042"], "at": "..." }
{ "log": "memory_review", "task": "build-1", "approved": ["fact:eg-0042"], "auto_approved": ["fact:eg-0001"], "rejected": ["fact:mg-0004"], "commented": ["fact:eg-0002"], "at": "..." }
```

Журнальные записи ссылаются на факты **только явными id** — упоминание прозой («заstale-ил
четыре факта») рождает в xmemory объекты-призраки. В режиме строительства журнал начинается с
memory_review/memory_write; memory_read появляется в режиме использования. Журналы отвечают на
вопросы демо и эвала: «какой факт в какую задачу попал», «что изменилось после прогона».

## Адаптер: xmemory (первичный)

1. Схему инстанса агент проектирует сам под выбранные срезы и **дорабатывает при эволюции**
   (новые срезы, новые поля, новые типы связей — не ломая старое). Не сваливать всё в один тип
   «текстовая заметка» — реляционность и есть смысл. **Стабильные первичные ключи обязательны**:
   `fact_id`, `entry_id` (`xmd generate` сам их не даёт — проверь и допиши через `xmd enhance`),
   иначе ломаются перезапись статуса, `superseded_by` и журналы, а повторное извлечение плодит
   дубликаты.
2. Затравка для `xmd generate` — ниже. Это **пример, не предписание**: перепиши описание под
   срезы и поля своего проекта, сохранив мини-ядро и журнальные связи.
3. Журналы — сущности со связями на факты и задачи: цепочка «факт → чтение → задача → изменение»
   должна доставаться обходом графа.
4. Снапшоты для эвалов: отдельный инстанс/неймспейс на конфигурацию эксперимента.
5. Практика xmemcli: креды (`.xmemrc.json`) ищутся от текущей директории вверх — **работай из
   корня проекта**, не из /tmp (иначе «Not logged in»; при необходимости — симлинк).
6. **Обязательная верификация после переноса**, тремя запросами: пересчёт фактов по срезам
   (ловит призраков); обход «факт → ревью → задача»; одна агентская выборка («собираюсь добавить
   доменное событие — что нужно знать») — релевантные факты возвращаются. Расхождение — чини до
   конца сессии.

Затравка (проверена на живом инстансе):

```bash
$XMEMCLI xmd generate "Memory for reverse-engineered technical facts about a software project.
Objects:
- Entity: primary key entity_id; kind (module, event, endpoint, table, external_system, flag, ...); name; attrs.
- Fact: primary key fact_id (slice-prefixed, e.g. 'fact:eg-0042'); statement (<=200 chars);
  evidence (list of 'file:line' or commit refs); confidence (high/medium/low);
  status (candidate/active/stale); provenance (declared/observed/inferred);
  type (slice); subject -> Entity; object -> Entity (optional); relation;
  auto_approved (bool); human_notes; question; source; superseded_by -> Fact; status_reason; created_at.
- JournalEntry: primary key entry_id; log (memory_read/memory_write/memory_review); task; at;
  explicit relations to Fact by fact_id: read_facts, created_facts, staled_facts, approved_facts,
  auto_approved_facts, rejected_facts, commented_facts. Journal entries reference facts only via
  these relations, never by textual description." -o schema.yml
$XMEMCLI xmd validate schema.yml
```

## Адаптер: файловый — fallback (`.tech-facts/` в корне репозитория)

Только когда xmemory недоступен:

```
.tech-facts/
  schema.json      # какие срезы включены, версия модели
  entities.jsonl   # по Entity на строку
  facts.jsonl      # по Fact на строку; правки статуса — перезапись строки по id
  journal.jsonl    # append-only
```

Диффы видны в git, снапшот памяти = коммит (удобно для эвалов). Ограничение: выборка связями —
грепом. При появлении xmemory мигрируй один-в-один и удали каталог — двух источников истины
быть не должно.

## Правила объёма

- В контекст задачи — 5–20 релевантных `active`-фактов по связям затронутых сущностей, не вся база.
- Дифф памяти на подтверждение человеку — ≤ 10 строк вида `+ fact:0090 (event-graph): ...` /
  `~ fact:0042 → stale: superseded by fact:0090`; больше — мини-ревью через UI.
