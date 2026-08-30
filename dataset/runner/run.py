#!/usr/bin/env python3
"""
Раннер одного прогона: одна задача, один режим памяти, один повтор.

    python dataset/runner/run.py --task a3 --mode memory-off --seed 1

Что делает по шагам:
  1. валидирует задачу (пути скрытых тестов реально есть в эталонном коммите);
  2. готовит изолированный git worktree на base_commit задачи;
  3. убирает чужие агентские файлы (AGENTS.md / CLAUDE.md) — в ОБОИХ режимах,
     иначе в memory-off приезжает чужая память, а в memory-on — две сразу;
  4. в memory-on кладёт .claude/settings.json с хуками и проверяет, что память
     реально уехала в контекст (пустой снапшот = прогон невалиден, не тихий ноль);
  5. запускает агента;
  6. снимает дифф, гоняет регрессию (скрытые тесты из неё исключены);
  7. накладывает скрытые тесты из эталонного коммита и гоняет их;
  8. пишет metrics.json + артефакты и убирает за собой worktree.

Скрытые тесты не «прячутся» — на base_commit их в новой редакции ещё нет.
Мы накладываем их поверх дерева агента после прогона.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import tomllib
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("нужен pyyaml: pip install pyyaml")

if sys.version_info < (3, 11):
    sys.exit("нужен python >= 3.11 (tomllib)")

ROOT = Path(__file__).resolve().parents[2]
HOOKS_DIR = ROOT / "dataset" / "hooks"

RC_TIMEOUT = -9


# --------------------------------------------------------------------------- утилиты


def sh(cmd, cwd=None, env=None, timeout=None, check=False):
    """Запуск команды. Таймаут не роняет прогон: rc=-9, частичные метрики сохраняются."""
    try:
        p = subprocess.run(
            cmd,
            cwd=cwd,
            env={**os.environ, **(env or {})},
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=isinstance(cmd, str),
            start_new_session=True,   # чтобы можно было убить всю группу
        )
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = (e.stderr or b"").decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        return RC_TIMEOUT, out, err + f"\n[kata] таймаут {timeout}s: {cmd}"
    if check and p.returncode != 0:
        raise RuntimeError(f"{cmd} -> rc={p.returncode}\n{p.stderr[-2000:]}")
    return p.returncode, p.stdout, p.stderr


EMPTY_TESTS = {"rc": None, "parsed": False, "tests": 0, "passed": 0, "failed": 0,
               "errors": 0, "skipped": 0, "green": False, "ratio": 0.0, "failing": []}


def parse_junit(xml_path: Path, rc: int) -> dict:
    """
    Результат считаем по junit-xml, а не по хвосту вывода: uv дописывает свои
    предупреждения после pytest, и парсинг строки «N passed» врёт. XML заодно
    даёт поимённый список упавших проверок — без него attribution не собрать.
    """
    if not xml_path.exists():
        return {**EMPTY_TESTS, "rc": rc}

    root = ET.parse(xml_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root)
    tests = failures = errors = skipped = 0
    failing = []
    for s in suites:
        tests += int(s.get("tests", 0))
        failures += int(s.get("failures", 0))
        errors += int(s.get("errors", 0))
        skipped += int(s.get("skipped", 0))
        for case in s.iter("testcase"):
            if case.find("failure") is not None or case.find("error") is not None:
                failing.append(f"{case.get('classname', '')}::{case.get('name', '')}")
    passed = tests - failures - errors - skipped
    ran = tests - skipped
    return {
        "rc": rc,
        "parsed": True,
        "tests": tests,
        "passed": passed,
        "failed": failures,
        "errors": errors,
        "skipped": skipped,
        # passed > 0 обязательно: иначе прогон, где всё скипнулось (нет LDAP-сервиса),
        # отчитается как зелёный при нуле пройденных проверок
        "green": failures == 0 and errors == 0 and passed > 0,
        "ratio": round(passed / ran, 3) if ran else 0.0,
        "failing": failing[:40],
    }


# --------------------------------------------------------------------------- модели


@dataclass
class Task:
    id: str
    solution_commit: str
    base_commit: str
    title: str
    prompt: str
    hidden_tests: list[str]
    slices: list[str] = field(default_factory=list)
    contract: str | None = None


def load_tasks(path: Path) -> tuple[dict, dict[str, Task]]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    tasks = {
        t["id"]: Task(
            id=t["id"],
            solution_commit=t["solution_commit"],
            base_commit=t["base_commit"],
            title=t["title"],
            prompt=" ".join(t["prompt"].split()),
            hidden_tests=t["hidden_tests"],
            slices=t.get("slices", []),
            contract=(" ".join(t["contract"].split()) if t.get("contract") else None),
        )
        for t in doc.get("tasks", [])
    }
    return doc.get("meta", {}) or {}, tasks


def validate_task(clone: Path, task: Task) -> list[str]:
    """Дешёвые проверки до того, как потрачены токены."""
    problems = []
    for sha in (task.base_commit, task.solution_commit):
        rc, _, _ = sh(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=clone)
        if rc != 0:
            problems.append(f"нет коммита {sha} в клоне")
    rc, out, _ = sh(["git", "ls-tree", "-r", "--name-only", task.solution_commit], cwd=clone)
    present = set(out.splitlines())
    for p in task.hidden_tests:
        if p not in present:
            problems.append(f"скрытый тест {p} отсутствует в {task.solution_commit}")
    return problems


# --------------------------------------------------------------------------- рабочее дерево


def ensure_clone(cfg) -> Path:
    clone = (ROOT / cfg["repo"]["clone"]).resolve()
    if not (clone / ".git").exists():
        clone.parent.mkdir(parents=True, exist_ok=True)
        print(f"[workspace] клонирую {cfg['repo']['url']} -> {clone}")
        sh(["git", "clone", cfg["repo"]["url"], str(clone)], check=True)
    else:
        sh(["git", "fetch", "--quiet", "--all"], cwd=clone)
    return clone


def make_worktree(clone: Path, base_commit: str, dest: Path) -> Path:
    sh(["git", "worktree", "prune"], cwd=clone)
    if dest.exists():
        sh(["git", "worktree", "remove", "--force", str(dest)], cwd=clone)
        shutil.rmtree(dest, ignore_errors=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    sh(["git", "worktree", "add", "--detach", "--force", str(dest), base_commit],
       cwd=clone, check=True)
    return dest


def drop_worktree(clone: Path, dest: Path) -> None:
    sh(["git", "worktree", "remove", "--force", str(dest)], cwd=clone)
    shutil.rmtree(dest, ignore_errors=True)
    sh(["git", "worktree", "prune"], cwd=clone)


def strip_foreign_memory(wt: Path, names: list[str]) -> list[str]:
    """
    Убираем чужие агентские файлы. Делаем это в ОБОИХ режимах: в memory-off иначе
    сравниваем не с пустотой, а с чужой памятью; в memory-on — получили бы две
    памяти сразу и не поняли, чья заслуга.
    """
    removed = []
    for name in names:
        p = wt / name
        if p.exists():
            p.unlink()
            removed.append(name)
    return removed


def install_hooks(wt: Path, write_back: bool) -> None:
    """
    memory-on: SessionStart читает память.

    Stop-хук (шаг актуализации памяти) ставим ТОЛЬКО когда памяти реально есть
    куда писать. Иначе он гарантированно добавляет memory-on лишний ход и лишние
    токены — то есть портит ровно ту метрику, ради которой всё затевалось.
    """
    settings = json.loads((HOOKS_DIR / "settings.memory-on.json").read_text(encoding="utf-8"))
    if not write_back:
        settings["hooks"].pop("Stop", None)
    claude_dir = wt / ".claude"
    claude_dir.mkdir(exist_ok=True)
    (claude_dir / "settings.json").write_text(
        json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")


# --------------------------------------------------------------------------- агент


def build_prompt(task: Task) -> str:
    """
    contract — только публичные имена (маршрут, поле схемы, переменная окружения).
    Их скрытый тест пиняет буквально, угадать нельзя ни с памятью, ни без, и без
    подсказки эвал мерил бы лотерею. Архитектура (где внутри и по какой конвенции)
    в промпт не попадает никогда — это ровно то, что проверяется.
    """
    parts = [task.prompt]
    if task.contract:
        parts.append(f"Публичный контракт, которого нужно придерживаться: {task.contract}")
    parts.append("Работай в этом репозитории. Реализуй изменение так, как это принято "
                 "в проекте. Когда закончишь — коротко перечисли, что изменил.")
    return "\n\n".join(parts)


def changed_sources(clone: Path, task: Task) -> list[str]:
    """Исходники эталонного коммита без тестов — для режима oracle.

    Удалённые файлы отфильтрованы: git checkout атомарен, один несуществующий
    путь отменяет весь checkout, и оракул тихо не накатывает ничего.
    """
    rc, out, _ = sh(["git", "show", "--diff-filter=ACMR", "--name-only", "--format=",
                     task.solution_commit], cwd=clone)
    if rc != 0:
        return []
    return [f for f in out.splitlines() if f.strip() and not f.startswith("tests/")]


def run_agent(kind: str, cfg, wt: Path, task: Task, clone: Path,
              run_dir: Path, env_extra: dict) -> dict:
    prompt = build_prompt(task)
    (run_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    t0 = time.time()

    if kind == "null":
        # ничего не делает: скрытые тесты обязаны упасть
        return {"kind": kind, "rc": 0, "wall_sec": 0.0, "usage": {}, "usage_parsed": True}

    if kind == "oracle":
        # накатывает исходники эталонного PR (без тестов): обязаны пройти.
        # Проверяет каркас, а не модель.
        paths = changed_sources(clone, task)
        if not paths:
            return {"kind": kind, "rc": 1, "wall_sec": time.time() - t0,
                    "usage": {}, "usage_parsed": True,
                    "error": "не удалось получить список исходников эталонного коммита"}
        rc, out, err = sh(["git", "checkout", task.solution_commit, "--", *paths], cwd=wt)
        (run_dir / "agent_stderr.log").write_text(err, encoding="utf-8")
        return {"kind": kind, "rc": rc, "wall_sec": time.time() - t0,
                "usage": {}, "usage_parsed": True}

    cmd = [c.replace("{prompt}", prompt) for c in cfg["agent"]["cmd"]]
    rc, out, err = sh(cmd, cwd=wt, env=env_extra, timeout=cfg["agent"].get("timeout_sec", 3600))
    (run_dir / "agent_stdout.log").write_text(out, encoding="utf-8")
    (run_dir / "agent_stderr.log").write_text(err, encoding="utf-8")

    usage, parsed = {}, False
    try:  # claude -p --output-format json отдаёт usage и стоимость
        payload = json.loads(out)
        u = payload.get("usage", {})
        usage = {
            "input_tokens": u.get("input_tokens"),
            "output_tokens": u.get("output_tokens"),
            "cache_read_tokens": u.get("cache_read_input_tokens"),
            "total_cost_usd": payload.get("total_cost_usd"),
            "num_turns": payload.get("num_turns"),
        }
        parsed = True
    except Exception as e:
        print(f"[usage] не разобрал вывод агента как JSON ({e}); ценовая ось будет пустой",
              file=sys.stderr)

    return {"kind": kind, "rc": rc, "wall_sec": time.time() - t0,
            "usage": usage, "usage_parsed": parsed}


# --------------------------------------------------------------------------- проверки


def capture_diff(wt: Path, run_dir: Path, exclude: list[str] | None = None) -> dict:
    """
    Из диффа выкидываем всё, что положил или убрал сам раннер:
      * .claude — наш служебный каталог; иначе memory-on систематически «на файл
        больше», а llm-judge, который «читает только дифф», узнаёт из него режим;
      * удалённые AGENTS.md / CLAUDE.md — иначе прогон, где агент не сделал ничего,
        отчитывается как «-238 строк».
    """
    specs = ["." , ":(exclude).claude"] + [f":(exclude){p}" for p in (exclude or [])]
    sh(["git", "add", "-A", "--", *specs], cwd=wt)
    _, diff, _ = sh(["git", "diff", "--cached"], cwd=wt)
    (run_dir / "diff.patch").write_text(diff, encoding="utf-8")
    _, stat, _ = sh(["git", "diff", "--cached", "--numstat"], cwd=wt)
    rows = [l.split("\t") for l in stat.splitlines() if l.strip()]
    touched = [r[2] for r in rows if len(r) == 3]
    return {
        "files_changed": len(touched),
        "touched": touched[:60],
        "agent_touched_tests": any(p.startswith("tests/") for p in touched),
        "insertions": sum(int(r[0]) for r in rows if r[0].isdigit()),
        "deletions": sum(int(r[1]) for r in rows if r[1].isdigit()),
    }


def run_tests(wt: Path, cfg, targets: list[str], run_dir: Path, label: str,
              ignore: list[str] | None = None) -> dict:
    xml = run_dir / f"{label}.xml"
    cmd = (cfg["repo"]["test_cmd"].split()
           + ["-q", "--no-header", "-p", "no:cacheprovider", f"--junitxml={xml}"]
           + [f"--ignore={p}" for p in (ignore or [])]
           + targets)
    rc, out, err = sh(cmd, cwd=wt, env=cfg["repo"].get("env", {}),
                      timeout=cfg["repo"].get("test_timeout_sec", 1800))
    (run_dir / f"pytest_{label}.log").write_text(out + err, encoding="utf-8")
    return parse_junit(xml, rc)


def overlay_hidden_tests(wt: Path, task: Task) -> None:
    sh(["git", "checkout", task.solution_commit, "--", *task.hidden_tests], cwd=wt, check=True)


# --------------------------------------------------------------------------- прогон


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="dataset/runner/config.toml")
    ap.add_argument("--tasks", default="dataset/tasks.yaml")
    ap.add_argument("--task", required=True)
    ap.add_argument("--mode", choices=["memory-off", "memory-on"], required=True)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--agent", default=None, help="claude | codex | null | oracle")
    ap.add_argument("--out", default="runs")
    ap.add_argument("--skip-setup", action="store_true")
    ap.add_argument("--keep-worktree", action="store_true",
                    help="не удалять рабочее дерево после прогона (для разбора)")
    args = ap.parse_args()

    cfg = tomllib.loads((ROOT / args.config).read_text(encoding="utf-8"))
    meta, tasks = load_tasks(ROOT / args.tasks)
    if args.task not in tasks:
        sys.exit(f"нет задачи {args.task}; есть: {', '.join(tasks)}")
    task = tasks[args.task]
    kind = args.agent or cfg["agent"]["kind"]
    write_back = bool(cfg.get("memory", {}).get("write_back", False))

    run_dir = ROOT / args.out / task.id / args.mode / f"seed{args.seed}"
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)

    clone = ensure_clone(cfg)

    problems = validate_task(clone, task)
    if problems:
        for p in problems:
            print(f"[валидация] {p}", file=sys.stderr)
        print("[валидация] задача не готова к прогону, токены не тратим", file=sys.stderr)
        return 3

    wt = make_worktree(clone, task.base_commit,
                       ROOT / args.out / "_wt" / f"{task.id}-{args.mode}-{args.seed}")
    try:
        removed = strip_foreign_memory(wt, cfg["repo"].get("strip_files", []))
        print(f"[workspace] {task.id} @ {task.base_commit}, убрано: {removed or '—'}")

        if args.mode == "memory-on":
            install_hooks(wt, write_back)

        if not args.skip_setup:
            rc, out, err = sh(cfg["repo"]["setup_cmd"], cwd=wt,
                              env=cfg["repo"].get("env", {}), timeout=3600)
            (run_dir / "setup.log").write_text(out + err, encoding="utf-8")
            if rc != 0:
                print("[setup] упал, дальше идти бессмысленно", file=sys.stderr)
                return 2

        env_extra = {
            **cfg["repo"].get("env", {}),
            "KATA_HOOKS_DIR": str(HOOKS_DIR),
            "KATA_RUN_DIR": str(run_dir),
            "KATA_MEMORY_MODE": cfg["memory"]["mode"],
            "KATA_FACTS_SNAPSHOT": str((ROOT / cfg["memory"]["snapshot"]).resolve()),
            "KATA_XMEM_INSTANCE": cfg["memory"].get("xmem_instance", ""),
            "KATA_TASK_ID": task.id,
            "KATA_SEED": str(args.seed),
        }

        print(f"[agent] {kind}, режим {args.mode}, сид {args.seed}"
              + (", запись памяти включена" if args.mode == "memory-on" and write_back else ""))
        agent = run_agent(kind, cfg, wt, task, clone, run_dir, env_extra)
        if agent["rc"] not in (0, None):
            print(f"[agent] rc={agent['rc']} — прогон пойдёт дальше, но смотри логи",
                  file=sys.stderr)

        ctx = run_dir / "context_injected.txt"
        ctx_chars = len(ctx.read_text(encoding="utf-8")) if ctx.exists() else 0
        # Молчаливый memory-on, в который ничего не приехало, — это memory-off
        # под другим именем. Такой прогон не считается.
        memory_ok = not (args.mode == "memory-on" and kind not in ("null", "oracle")
                         and ctx_chars == 0)
        if not memory_ok:
            print("[память] в контекст ничего не уехало: снапшот пуст или хук не отработал.\n"
                  "         Прогон помечен невалидным — сравнивать его с memory-off нельзя.",
                  file=sys.stderr)

        diff = capture_diff(wt, run_dir, exclude=removed)
        print(f"[diff] файлов {diff['files_changed']}, +{diff['insertions']}/-{diff['deletions']}")

        # регрессия — на дереве агента, до наложения скрытых тестов.
        # Скрытые тесты исключены: в старой редакции они могут честно упасть
        # на правильной реализации, и это не «сломал чужое».
        regression = run_tests(wt, cfg, [cfg["repo"]["regression_scope"]], run_dir,
                               "regression", ignore=task.hidden_tests)

        overlay_hidden_tests(wt, task)
        hidden = run_tests(wt, cfg, task.hidden_tests, run_dir, "hidden")

        metrics = {
            "task": task.id,
            "title": task.title,
            "mode": args.mode,
            "seed": args.seed,
            "agent": agent["kind"],
            "agent_rc": agent["rc"],
            "agent_cmd": cfg["agent"].get("cmd") if kind not in ("null", "oracle") else None,
            "memory_mode": cfg["memory"]["mode"],
            "memory_write_back": write_back,
            "memory_ok": memory_ok,
            "base_commit": task.base_commit,
            "solution_commit": task.solution_commit,
            "c0": meta.get("c0"),
            "slices": task.slices,
            "wall_sec": round(agent["wall_sec"], 1),
            "usage": agent["usage"],
            "usage_parsed": agent["usage_parsed"],
            "diff": diff,
            "regression": regression,
            "hidden": hidden,
            "score": hidden["ratio"],          # доля пройденных проверок, не бинарь
            "score_binary": 1.0 if hidden["green"] else 0.0,
            "context_injected_chars": ctx_chars,
        }
        (run_dir / "metrics.json").write_text(
            json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")

        verdict = "ЗЕЛЁНО" if hidden["green"] else "красно"
        print(f"[итог] скрытые: {verdict} "
              f"({hidden['passed']}/{max(hidden['tests'] - hidden['skipped'], 0)} "
              f"= {hidden['ratio']}), регрессия: {'ok' if regression['green'] else 'красная'}"
              + ("" if memory_ok else ", ПАМЯТЬ НЕ ПРИЕХАЛА"))
        print(f"[итог] артефакты в {run_dir}")
        return 0
    finally:
        if not args.keep_worktree:
            drop_worktree(clone, wt)


if __name__ == "__main__":
    raise SystemExit(main())
