#!/usr/bin/env python3
"""
Прогон матрицы: задачи × режимы × повторы. Собирает результаты в таблицу.

    # самопроверка каркаса — обязательна перед первым настоящим прогоном
    python dataset/runner/sweep.py --selftest

    # этап 1
    python dataset/runner/sweep.py --seeds 3

    # одна задача, быстро
    python dataset/runner/sweep.py --tasks a3 --seeds 1

Порядок режимов чередуется между задачами — этого требует протокол эвала,
иначе систематический эффект «второй прогон всегда теплее» ляжет на один режим.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("нужен pyyaml: pip install pyyaml")

ROOT = Path(__file__).resolve().parents[2]
RUN = [sys.executable, str(Path(__file__).with_name("run.py"))]
MODES = ["memory-off", "memory-on"]


def task_ids(tasks_path: Path) -> list[str]:
    doc = yaml.safe_load(tasks_path.read_text(encoding="utf-8"))
    return [t["id"] for t in doc.get("tasks", [])]


def one(task: str, mode: str, seed: int, extra: list[str], out: str = "runs") -> int:
    cmd = RUN + ["--task", task, "--mode", mode, "--seed", str(seed), "--out", out] + extra
    print(f"\n=== {task} · {mode} · seed{seed} " + "=" * 30)
    return subprocess.run(cmd, cwd=ROOT).returncode


def collect(out_dir: Path) -> list[dict]:
    """Только настоящие прогоны.

    Псевдоагенты null и oracle живут в отдельном каталоге, но фильтр по полю
    agent оставлен на случай ручных запусков: одна забытая oracle-строка
    превращается в «победу memory-off» в сводке.
    """
    rows = []
    for m in sorted(out_dir.rglob("metrics.json")):
        r = json.loads(m.read_text(encoding="utf-8"))
        if r.get("agent") in ("null", "oracle"):
            continue
        if r.get("memory_ok") is False:
            print(f"[сводка] пропускаю невалидный прогон {r['task']}/{r['mode']}/seed{r['seed']}: "
                  "память не приехала в контекст")
            continue
        rows.append(r)
    return rows


def write_table(rows: list[dict], out_dir: Path) -> None:
    cols = ["task", "mode", "seed", "agent", "score", "score_binary", "agent_rc",
            "hidden_failed", "regression_green",
            "files_changed", "wall_sec", "input_tokens", "output_tokens",
            "cache_read_tokens", "total_cost_usd", "num_turns",
            "agent_touched_tests", "context_chars"]
    csv_path = out_dir / "results.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            u = r.get("usage") or {}
            w.writerow({
                "task": r["task"], "mode": r["mode"], "seed": r["seed"], "agent": r["agent"],
                "score": r["score"],
                "score_binary": r.get("score_binary"),
                "agent_rc": r.get("agent_rc"),
                "hidden_failed": r["hidden"].get("failed", 0) + r["hidden"].get("errors", 0),
                "regression_green": r["regression"].get("green"),
                "files_changed": r["diff"]["files_changed"],
                "wall_sec": r["wall_sec"],
                "input_tokens": u.get("input_tokens"),
                "output_tokens": u.get("output_tokens"),
                "cache_read_tokens": u.get("cache_read_tokens"),
                "total_cost_usd": u.get("total_cost_usd"),
                "num_turns": u.get("num_turns"),
                "agent_touched_tests": r["diff"]["agent_touched_tests"],
                "context_chars": r.get("context_injected_chars", 0),
            })
    print(f"\n[таблица] {csv_path}")

    # сводка off vs on: доля зелёных и медианная цена
    print(f"\n{'задача':6} {'режим':12} {'зелёных':>8} {'ср. токенов вход':>18} {'ср. сек':>9}")
    for task in sorted({r["task"] for r in rows}):
        for mode in MODES:
            sel = [r for r in rows if r["task"] == task and r["mode"] == mode]
            if not sel:
                continue
            green = sum(1 for r in sel if r["score"] == 1.0)
            toks = [(r.get("usage") or {}).get("input_tokens") for r in sel]
            toks = [t for t in toks if t]
            secs = [r["wall_sec"] for r in sel]
            print(f"{task:6} {mode:12} {green}/{len(sel):>6} "
                  f"{(sum(toks)//len(toks) if toks else 0):>18} "
                  f"{(sum(secs)/len(secs)):>9.0f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks-file", default="dataset/tasks.yaml")
    ap.add_argument("--tasks", nargs="*", help="подмножество id задач")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--out", default="runs")
    ap.add_argument("--selftest", action="store_true",
                    help="прогнать null и oracle: каркас должен показать красно и зелёно")
    ap.add_argument("--skip-setup", action="store_true")
    args = ap.parse_args()

    ids = args.tasks or task_ids(ROOT / args.tasks_file)
    extra = ["--skip-setup"] if args.skip_setup else []

    if args.selftest:
        # Обязательный ритуал перед каждым новым набором задач.
        # null не делает ничего -> скрытые тесты обязаны упасть.
        # oracle кладёт исходники эталонного PR -> обязаны пройти.
        # Если это не так, задача не измеряет ничего, и никакая модель не поможет.
        bad = []
        for task in ids:
            for kind, must_be_green in (("null", False), ("oracle", True)):
                out = f"{args.out}/_selftest/{kind}"
                one(task, "memory-off", 0, extra + ["--agent", kind], out=out)
                m = ROOT / out / task / "memory-off" / "seed0" / "metrics.json"
                green = json.loads(m.read_text())["hidden"]["green"] if m.exists() else None
                ok = (green is must_be_green)
                print(f"[selftest] {task} {kind}: скрытые {'зелёные' if green else 'красные'} "
                      f"-> {'ok' if ok else 'ПРОБЛЕМА'}")
                if not ok:
                    bad.append(f"{task}/{kind}")
        if bad:
            print(f"\n[selftest] задачи не измеряют ничего: {', '.join(bad)}")
            return 1
        print("\n[selftest] каркас меряет то, что должен")
        return 0

    for i, task in enumerate(ids):
        modes = MODES if i % 2 == 0 else list(reversed(MODES))   # чередуем порядок
        for seed, mode in itertools.product(range(1, args.seeds + 1), modes):
            one(task, mode, seed, extra, out=args.out)

    write_table(collect(ROOT / args.out), ROOT / args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
