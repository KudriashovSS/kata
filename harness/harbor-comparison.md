# Сравнение Claude Code и Codex через Harbor

Актуально на 30.08.2026.

Harbor запускает агента не на произвольной строке prompt, а на задаче с инструкцией,
изолированным окружением и проверкой результата. Для честного сравнения Claude Code и Codex
оба агента должны получать одну и ту же задачу и стартовое состояние.

## Установка и доступ

```bash
uv tool install harbor

export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
```

Ключи не следует сохранять в конфигурации или коммитить в репозиторий.

## Формат задачи

Минимальный каталог задачи:

```text
tasks/fix-bug/
├── instruction.md
├── task.toml
├── environment/
│   └── Dockerfile
└── tests/
    └── test.sh
```

- `instruction.md` — одинаковое задание для обоих агентов;
- `task.toml` — таймауты и параметры среды;
- `environment/Dockerfile` — одинаковая начальная версия проекта;
- `tests/test.sh` — проверка результата и запись числового reward в
  `/logs/verifier/reward.txt`.

## Одиночный пробный запуск

Claude Code:

```bash
harbor trial start \
  -p ./tasks/fix-bug \
  -a claude-code \
  -m anthropic/claude-opus-5
```

Codex:

```bash
harbor trial start \
  -p ./tasks/fix-bug \
  -a codex \
  -m openai/gpt-5.6-sol
```

Идентификаторы моделей выше приведены как пример. Для воспроизводимого сравнения нужно
зафиксировать доступные model snapshot, версию Harbor и версии обоих CLI.

## Сравнительный прогон

Конфигурация `harbor.yaml`:

```yaml
job_name: claude-vs-codex
jobs_dir: ./harbor-results
n_attempts: 3

datasets:
  - path: ./tasks

agents:
  - name: claude-code
    model_name: anthropic/claude-opus-5

  - name: codex
    model_name: openai/gpt-5.6-sol

environment:
  type: docker
  delete: true

orchestrator:
  type: local
  n_concurrent_trials: 2
```

Запуск:

```bash
harbor run -c harbor.yaml
```

Число trials равно:

```text
число агентов × число задач × n_attempts
```

Для двух агентов, одной задачи и трёх попыток Harbor выполнит шесть trials.

## Результаты

По умолчанию результаты сравнительного запуска будут находиться в:

```text
harbor-results/claude-vs-codex/
├── config.json
├── result.json
└── <trial>/
    ├── config.json
    ├── result.json
    ├── agent/
    │   └── trajectory.json
    └── verifier/
```

Локальный интерфейс результатов:

```bash
harbor view ./harbor-results
```

`result.json` содержит статус, reward, ошибки и временные данные trial.
`agent/trajectory.json` использует формат ATIF и содержит шаги агента, tool calls и итоговые
метрики:

| Нужная метрика | Поле или способ расчёта |
| --- | --- |
| Входящие токены | `final_metrics.total_prompt_tokens` |
| Исходящие токены | `final_metrics.total_completion_tokens` |
| Прочитанные из кеша | `final_metrics.total_cached_tokens` |
| Записанные в кеш Codex | `final_metrics.extra.total_cache_write_input_tokens` |
| Reasoning-токены Codex | `final_metrics.extra.reasoning_output_tokens` |
| Оценка стоимости | `final_metrics.total_cost_usd` |
| Tool calls | сумма элементов `steps[].tool_calls[]` |
| Wall-clock | duration/timestamps соответствующего trial в `result.json` или viewer |

Пример извлечения метрик из одного trajectory:

```bash
jq '{
  input_tokens:       .final_metrics.total_prompt_tokens,
  output_tokens:      .final_metrics.total_completion_tokens,
  cached_tokens:      (.final_metrics.total_cached_tokens // 0),
  cache_write_tokens: (.final_metrics.extra.total_cache_write_input_tokens // 0),
  reasoning_tokens:   (.final_metrics.extra.reasoning_output_tokens // 0),
  estimated_cost_usd: .final_metrics.total_cost_usd,
  tool_calls:         ([.steps[]?.tool_calls[]?] | length)
}' ./harbor-results/claude-vs-codex/<trial>/agent/trajectory.json
```

## Как интерпретировать сравнение

- `total_cost_usd` обычно является оценкой по API-прайсу, а не фактическим списанием с
  подписки Claude или ChatGPT/Codex.
- У Anthropic и OpenAI различается семантика кешированных токенов; сравнивать нужно отдельные
  категории, а не только общий `input`.
- `steps[].tool_calls` считает предложенные вызовы. Для числа завершённых вызовов нужно
  сопоставлять `tool_call_id` с результатами observation.
- Вместе с ценой и временем обязательно сравнивать reward/status: быстро завершившаяся ошибка
  не является хорошим результатом.
- Для эксперимента `memory-off` против `memory-on` агент и модель внутри пары должны оставаться
  одинаковыми. Сравнение Claude против Codex — отдельная экспериментальная ось.

## Документация

- [Harbor: Getting Started](https://www.harborframework.com/docs/getting-started)
- [Harbor: Agents](https://www.harborframework.com/docs/agents)
- [Harbor: Run Evals и структура результатов](https://www.harborframework.com/docs/run-jobs/run-evals)
- [Agent Trajectory Interchange Format](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
