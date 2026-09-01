#!/usr/bin/env python3
"""
Прогон матрицы: задачи × режимы × повторы. Собирает результаты в таблицу.

    # самопроверка каркаса — обязательна перед первым настоящим прогоном
    python dataset/runner/sweep.py --selftest

    # этап 1
    python dataset/runner/sweep.py --seeds 3

    # одна задача, быстро
    python dataset/runner/sweep.py --tasks a3 --seeds 1

Порядок режимов чередуется между сидами и задачами — этого требует протокол эвала,
иначе систематический эффект «второй прогон всегда теплее» ляжет на один режим.
"""

from __future__ import annotations

import argparse
import csv
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


def collect(out_dir: Path, expected: set[tuple[str, str, int]] | None = None) -> list[dict]:
    """Только настоящие прогоны текущей матрицы.

    Псевдоагенты null и oracle живут в отдельном каталоге, но фильтр по полю
    agent оставлен на случай ручных запусков: одна забытая oracle-строка
    превращается в «победу memory-off» в сводке.
    """
    rows = []
    for m in sorted(out_dir.rglob("metrics.json")):
        r = json.loads(m.read_text(encoding="utf-8"))
        if r.get("agent") in ("null", "oracle"):
            continue
        key = (r["task"], r["mode"], r["seed"])
        if expected is not None and key not in expected:
            continue
        rows.append(r)
    return rows


def write_table(rows: list[dict], out_dir: Path) -> None:
    cols = ["task", "mode", "seed", "agent", "agent_model", "agent_effort", "valid_run",
            "invalid_reasons", "task_success", "score", "score_binary", "agent_rc",
            "hidden_failed", "regression_green",
            "files_changed", "wall_sec", "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_creation_tokens", "total_cost_usd", "num_turns",
            "agent_touched_tests", "context_chars"]
    csv_path = out_dir / "results.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for r in rows:
            u = r.get("usage") or {}
            w.writerow({
                "task": r["task"], "mode": r["mode"], "seed": r["seed"], "agent": r["agent"],
                "agent_model": r.get("agent_model"),
                "agent_effort": r.get("agent_effort"),
                "valid_run": r.get("valid_run"),
                "invalid_reasons": ";".join(r.get("invalid_reasons") or []),
                "task_success": r.get("task_success"),
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
                "cache_creation_tokens": u.get("cache_creation_tokens"),
                "total_cost_usd": u.get("total_cost_usd"),
                "num_turns": u.get("num_turns"),
                "agent_touched_tests": r["diff"]["agent_touched_tests"],
                "context_chars": r.get("context_injected_chars", 0),
            })
    print(f"\n[таблица] {csv_path}")

    # Невалидные строки остаются в CSV для разбора, но в сравнительную сводку не входят.
    print(f"\n{'задача':6} {'режим':12} {'успех':>8} {'валидно':>8} "
          f"{'ср. токенов вход':>18} {'ср. сек':>9}")
    for task in sorted({r["task"] for r in rows}):
        for mode in MODES:
            sel = [r for r in rows if r["task"] == task and r["mode"] == mode]
            if not sel:
                continue
            valid = [r for r in sel if r.get("valid_run")]
            success = sum(1 for r in valid if r.get("task_success"))
            toks = [(r.get("usage") or {}).get("input_tokens") for r in valid]
            toks = [t for t in toks if t]
            secs = [r["wall_sec"] for r in valid]
            print(f"{task:6} {mode:12} {success}/{len(valid):>6} {len(valid)}/{len(sel):>6} "
                  f"{(sum(toks)//len(toks) if toks else 0):>18} "
                  f"{(sum(secs)/len(secs) if secs else 0):>9.0f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks-file", default="dataset/tasks.yaml")
    ap.add_argument("--config", default="dataset/runner/config.toml")
    ap.add_argument("--tasks", nargs="*", help="подмножество id задач")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--out", default="runs")
    ap.add_argument("--selftest", action="store_true",
                    help="прогнать null и oracle: каркас должен показать красно и зелёно")
    ap.add_argument("--skip-setup", action="store_true")
    args = ap.parse_args()

    ids = args.tasks or task_ids(ROOT / args.tasks_file)
    extra = ["--config", args.config]
    if args.skip_setup:
        extra.append("--skip-setup")

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
                metrics = json.loads(m.read_text()) if m.exists() else {}
                green = metrics.get("hidden", {}).get("green")
                regression_green = metrics.get("regression", {}).get("green")
                valid = metrics.get("valid_run")
                ok = (green is must_be_green) and regression_green is True and valid is True
                print(f"[selftest] {task} {kind}: скрытые {'зелёные' if green else 'красные'} "
                      f"регрессия {'зелёная' if regression_green else 'красная'} "
                      f"-> {'ok' if ok else 'ПРОБЛЕМА'}")
                if not ok:
                    bad.append(f"{task}/{kind}")
        if bad:
            print(f"\n[selftest] задачи не измеряют ничего: {', '.join(bad)}")
            return 1
        print("\n[selftest] каркас меряет то, что должен")
        return 0

    expected = {(task, mode, seed) for task in ids for mode in MODES
                for seed in range(1, args.seeds + 1)}
    failed_commands = []
    for i, task in enumerate(ids):
        for seed in range(1, args.seeds + 1):
            # Балансируем порядок внутри одной задачи, а не только между задачами.
            modes = MODES if (i + seed) % 2 else list(reversed(MODES))
            for mode in modes:
                if one(task, mode, seed, extra, out=args.out) != 0:
                    failed_commands.append((task, mode, seed))

    rows = collect(ROOT / args.out, expected)
    write_table(rows, ROOT / args.out)
    seen = {(r["task"], r["mode"], r["seed"]) for r in rows}
    missing = sorted(expected - seen)
    invalid = sorted((r["task"], r["mode"], r["seed"])
                     for r in rows if not r.get("valid_run"))
    if failed_commands or missing or invalid:
        print(f"\n[матрица] НЕПОЛНА: commands={failed_commands}, missing={missing}, invalid={invalid}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
