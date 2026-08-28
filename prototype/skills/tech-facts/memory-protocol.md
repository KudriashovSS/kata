# Протокол памяти

Единственный источник истины о фактах — **xmemory**. Всё, что лежит в рабочем каталоге UI
(`/tmp/...`) — витрина и транспорт, оно одноразовое; правки фактов существуют только как записи
в памяти. Файловый адаптер `~/.tech-facts/<slug-проекта>/` — fallback исключительно когда xmemory
недоступен (при появлении — мигрируй и удали). **В репозиторий пользователя не пишем ничего** —
ни витрину, ни память: репо — чужая территория, и вопрос «коммитить или в .gitignore» просто
не должен возникать.

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

### 0. Установка и вход

```bash
uv tool install xmemcli            # в PATH его обычно нет
xmemcli auth status                # {"authenticated": true} — можно работать
xmemcli auth login                 # иначе: печатает ссылку и ждёт человека
```
`auth login` блокируется до подтверждения в браузере и печатает ссылку **в stdout**: не заворачивай
его в пайп (`| tail` съест ссылку) и не жди сам — запусти в фоне, ссылку отдай человеку. Ключ он
кладёт в `.xmemrc.json` (`email`, `api_url`, `api_key`) в текущей директории — клади его **вне
репозитория пользователя**, это секрет в открытом виде.

### 1. Схема

Схему агент проектирует сам под выбранные срезы и **дорабатывает при эволюции** (новые срезы, поля,
типы связей — не ломая старое). Не сваливать всё в один тип «текстовая заметка» — реляционность и
есть смысл. **Стабильные первичные ключи обязательны**: `entity_id`, `fact_id`, `entry_id`
(`xmd generate` их не гарантирует — проверь и допиши). Ключ — единственный способ адресовать
объект: строку без ключа потом нельзя ни исправить, ни удалить, а повторное извлечение плодит
дубликаты.

```bash
xmemcli xmd generate "<описание под свои срезы>" -o schema.yml   # затравка ниже
xmemcli xmd validate schema.yml
xmemcli instance create --name <slug> --schema-file schema.yml --schema-type json
```
`xmd generate` отдаёт JSON — при имени `schema.yml` укажи `--schema-type json`, иначе создание
инстанса упрётся в разбор YAML.

**Правка схемы после создания.** Аддитивное (новый объект, новое поле) проходит как есть; всё
остальное — включая расширение `enum` — сервер отвергает с `non_additive_change_requires_plan`.
Путь эволюции — план миграции:
```bash
xmemcli xmd enhance --from-instance --instance-id <id> "<что меняем>" \
  -o schema2.yml --plan-output plan.json
xmemcli schema update <id> --schema-file schema2.yml --migration-plan plan.json
```

### 2. Запись — только `structured_mutations`

**Писать факты через `xmemcli write` (и MCP-`write` с полем `text`) запрещено.** Это извлечение
моделью из прозы: медленно (~8 с на запись) и, что важнее, **сочиняет объекты и связи, которых в
тексте не было**. Полевой прогон на 102 записях: строка `Entity` с пустым `entity_id` при
`required: true`, 20 лишних связей `fact_object` (дубль субъекта) и осиротевшая связь с пустым
концом. Объекты-призраки, от которых предостерегает этот протокол, рождаются именно здесь — и
безключевую строку уже не удалить.

Пиши прямо в API: детерминированно, без LLM, батчем.
```bash
KEY=$(node -e 'process.stdout.write(require("<путь>/.xmemrc.json").api_key)')
curl -s -X POST "https://api.xmemory.ai/instances/$INSTANCE/write" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d @mutations.json
```
```json
{"structured_mutations": [
  {"object_mutation": {"object_type": "Entity", "create": {
     "key": {"entity_id": "sp-registry"},
     "values": {"kind": "collector", "name": "sp-registry"}}}},
  {"object_mutation": {"object_type": "Fact", "create": {
     "key": {"fact_id": "fact:pg-0002"},
     "values": {"statement": "…", "confidence": "high", "status": "candidate"}}}},
  {"relation_mutation": {"relation_type": "fact_subject", "create": {
     "endpoints": [{"object_name": "fact", "key": {"fact_id": "fact:pg-0002"}},
                   {"object_name": "subject_entity", "key": {"entity_id": "sp-registry"}}]}}}
]}
```
Мутации применяются по порядку и поздние видят созданное ранними — сущности, факты и связи уезжают
одним вызовом. `update` и `delete` адресуют по тому же `key`: смена статуса на ревью — это `update`
существующего факта, а не новая запись. Порядок величин: батч из сотни мутаций — секунды.

`xmemcli` остаётся для `auth`, `xmd`, `schema`, `instance` и `read`.

### 3. Журналы, снапшоты, практика

- Журналы — сущности со связями на факты и задачи: цепочка «факт → чтение → задача → изменение»
  должна доставаться обходом графа.
- Снапшоты для эвалов: отдельный инстанс/неймспейс на конфигурацию эксперимента.
- Креды ищутся от текущей директории вверх — зови `xmemcli` из директории, где лежит
  `.xmemrc.json` (иначе «Not logged in»), а не из `/tmp`.

### 4. Верификация — сверяй множества ключей, а не числа

Обязательна после первой записи срезов и после применения решений человека.

**Только `--read-mode raw`.** Обычный `read` отвечает прозой от модели и в подсчётах врёт: на
полевом прогоне он уверенно сказал «50 Entity» там, где их было 49.

**Сверяй множества id диффом с витриной, а не количества.** На том же прогоне пересчёт фактов по
срезам сошёлся идеально и не заметил ни одного из трёх дефектов — они сидели в сущностях и связях,
которых пересчёт не трогал.

```bash
xmemcli read "Перечисли entity_id всех Entity" --read-mode raw
xmemcli read "Для каждой связи fact_subject верни fact_id факта и entity_id субъекта" --read-mode raw
```
Формулируй запрос через имена полей: на «верни fact_id и entity_id» reader может отдать внутренние
uuid, и дифф развалится на ровном месте — сначала посмотри `columns`, потом сравнивай. Поверх
диффов — три содержательные проверки: обход «факт → ревью → задача»; агентская выборка
(«собираюсь добавить доменное событие — что нужно знать»); совпадение статусов с решениями
человека. Расхождение — чини до конца сессии.

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

## Адаптер: файловый — fallback (`~/.tech-facts/<slug-проекта>/`, вне репозитория)

Только когда xmemory недоступен и человек согласился строить память локально:

```
~/.tech-facts/<slug-проекта>/
  schema.json      # какие срезы включены, версия модели
  entities.jsonl   # по Entity на строку
  facts.jsonl      # по Fact на строку; правки статуса — перезапись строки по id
  journal.jsonl    # append-only
```

Ограничения, о которых нужно сказать человеку **вслух и сразу** (это не полноценная память):
живёт на одной машине у одного человека, командой не шарится, выборка связями — грепом,
переезд на другую машину — руками. Именно поэтому режим объявляется явно:

- в `picker.json` кладётся блок `memory` ([формат](ui-protocol.md)) — шелл держит жёлтую полосу
  «память сохраняется локально» на каждом экране, пока режим не сменится;
- при появлении xmemory мигрируй один-в-один и удали каталог — двух источников истины быть не
  должно; после миграции обнови блок `memory` (`backend: "xmemory"`), полоса погаснет сама.

## Правила объёма

- В контекст задачи — 5–20 релевантных `active`-фактов по связям затронутых сущностей, не вся база.
- Дифф памяти на подтверждение человеку — ≤ 10 строк вида `+ fact:0090 (event-graph): ...` /
  `~ fact:0042 → stale: superseded by fact:0090`; больше — мини-ревью через UI.
