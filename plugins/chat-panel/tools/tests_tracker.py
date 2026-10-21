"""
Test tracking for the chat-panel "Tests" section: which test files the session touched, the result of
each file's last run, and the tests the assistant proposed but has not written.

The state lives in state/<session>.tests.json and only this module writes it, under a lock, so the mod's
hooks and a long background run never overwrite each other. Paths are keys relative to the session's
working directory, as pytest prints them.

pytest only. A run started by the assistant is parsed from its output (best effort: per-file progress
lines, FAILED/ERROR lines and the summary); the automatic rerun writes a JUnit report and is exact.
"""
import contextlib
import fcntl
import json
import os
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

RUN_TIMEOUT_S = 300
DEFAULT_COMMAND = "uv run pytest --no-cov"
FAILING_SHOWN = 5

TEST_FILE = re.compile(r"(^|/)(test_[^/]*|[^/]*_test)\.py$")
PROGRESS_LINE = re.compile(r"^(\S+\.py) ([.FEsxX]+)\s*(\[\s*\d+%\])?\s*$")
CONTINUATION_LINE = re.compile(r"^([.FEsxX]+)\s*(\[\s*\d+%\])?\s*$")
FAILED_LINE = re.compile(r"^(FAILED|ERROR) (\S+?\.py)(?:::(\S+))?")
SUMMARY_COUNT = re.compile(r"(\d+) (passed|failed|errors?)\b")


def is_test_path(path: str) -> bool:
    """Whether a path names a pytest file: test_*.py or *_test.py."""
    return bool(TEST_FILE.search(path))


def empty() -> dict:
    return {"files": {}, "proposed": [], "running": None}


@contextlib.contextmanager
def locked(path: str):
    """
    Read the state under an exclusive lock and write it back when the block ends.
    :param path: the session's tests.json
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            data = empty()
        yield data
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, path)


def read(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return empty()


def touch(data: dict, paths: list[str], cwd: str, now: float) -> None:
    """
    Mark test files as changed: a file with a result turns stale, a new one is not run yet.
    :param paths: absolute or cwd-relative paths; ones that are not test files are ignored
    """
    for path in paths:
        if not is_test_path(path):
            continue
        key = os.path.relpath(path, cwd) if os.path.isabs(path) else path
        entry = data["files"].setdefault(key, {"status": "not-run", "passed": None, "failed": None, "failing": [],
                                               "ranAt": None})
        entry["touchedAt"] = now
        if entry["status"] != "running":
            entry["status"] = "stale" if entry.get("ranAt") else "not-run"


def parse_output(output: str, command_files: list[str]) -> dict[str, dict]:
    """
    Per-file results from pytest's console output.
    :param output: what the pytest command printed
    :param command_files: the test files the command named, for output without per-file progress lines
    :return: {file: {"passed", "failed", "failing"}}; passed is None when the output does not say
    """
    results: dict[str, dict] = {}
    current = None

    def add(file: str, marks: str) -> None:
        r = results.setdefault(file, {"passed": 0, "failed": 0, "failing": []})
        r["passed"] += marks.count(".")
        r["failed"] += marks.count("F") + marks.count("E")

    for line in output.splitlines():
        if m := PROGRESS_LINE.match(line):
            current = m.group(1)
            add(current, m.group(2))
        elif current and (m := CONTINUATION_LINE.match(line)):
            add(current, m.group(1))
        else:
            current = None
    has_progress = bool(results)

    for line in output.splitlines():
        if m := FAILED_LINE.match(line):
            r = results.setdefault(m.group(2), {"passed": None, "failed": 0, "failing": []})
            name = m.group(3) or "(collection error)"
            if name not in r["failing"]:
                r["failing"].append(name)
            if not has_progress:
                r["failed"] += 1

    if not has_progress:
        counts = {}
        for n, kind in SUMMARY_COUNT.findall(output):
            counts[kind.rstrip("s") if kind.startswith("error") else kind] = int(n)
        if len(command_files) == 1:
            r = results.setdefault(command_files[0], {"passed": None, "failed": 0, "failing": []})
            r["passed"] = counts.get("passed")
            r["failed"] = counts.get("failed", 0) + counts.get("error", 0)
        elif counts and not counts.get("failed") and not counts.get("error"):
            for file in command_files:
                results.setdefault(file, {"passed": None, "failed": 0, "failing": []})
    return results


def command_files(command: str) -> list[str]:
    """The test files a pytest command names, node ids cut to their file."""
    return [w.split("::")[0] for w in command.split() if is_test_path(w.split("::")[0])]


def record(data: dict, results: dict[str, dict], ran_at: float, source: str) -> None:
    """
    Store run results for test files the session tracks; a file edited during the run stays stale.
    :param results: {file: {"passed", "failed", "failing"}}
    :param ran_at: when the run started
    """
    for file, r in results.items():
        entry = data["files"].get(file)
        if entry is None:
            continue
        entry.update(passed=r["passed"], failed=r["failed"], failing=r["failing"], ranAt=ran_at, source=source)
        if entry.get("touchedAt", 0) > ran_at:
            entry["status"] = "stale"
        else:
            entry["status"] = "failed" if r["failed"] else "passed"


def parse_junit(xml_text: str) -> dict[str, dict]:
    """Per-file results from a JUnit report written with junit_family=xunit1 (its testcases carry `file`)."""
    results: dict[str, dict] = {}
    for case in ET.fromstring(xml_text).iter("testcase"):
        file = case.get("file")
        if not file:
            continue
        r = results.setdefault(file, {"passed": 0, "failed": 0, "failing": []})
        if case.find("failure") is not None or case.find("error") is not None:
            r["failed"] += 1
            r["failing"].append(case.get("name", "?"))
        elif case.find("skipped") is None:
            r["passed"] += 1
    return results


def due(data: dict, cwd: str) -> list[str]:
    """The tracked test files changed since their last run, that still exist."""
    return sorted(f for f, e in data["files"].items()
                  if e.get("status") != "running" and e.get("touchedAt", 0) > (e.get("ranAt") or 0)
                  and os.path.exists(os.path.join(cwd, f)))


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def run(path: str, cwd: str, base_command: str = DEFAULT_COMMAND, only: list[str] | None = None) -> str:
    """
    Rerun the changed test files with pytest and store the results. Does nothing while a run is going.
    :param path: the session's tests.json
    :param cwd: the session's working directory
    :param base_command: the pytest command line before the file names, split on spaces
    :param only: rerun these tracked files now, changed or not; absent, the files changed since their last run
    :return: one line for the caller
    """
    with locked(path) as data:
        running = data.get("running")
        if running and _alive(running["pid"]):
            return "A run is already going."
        files = due(data, cwd) if only is None else sorted(
            f for f in only if f in data["files"] and os.path.exists(os.path.join(cwd, f)))
        if not files:
            data["running"] = None
            return "Nothing to rerun."
        started = time.time()
        data["running"] = {"pid": os.getpid(), "startedAt": started}
        for f in files:
            data["files"][f]["status"] = "running"

    fd, report = tempfile.mkstemp(suffix=".xml")
    os.close(fd)
    command = [*base_command.split(), *files, "-q", "-p", "no:cacheprovider",
               "-o", "junit_family=xunit1", f"--junitxml={report}"]
    status, results = None, {}
    try:
        subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=RUN_TIMEOUT_S)
        with open(report, encoding="utf-8") as f:
            results = parse_junit(f.read())
    except subprocess.TimeoutExpired:
        status = "timeout"
    except (OSError, ET.ParseError):
        status = "error"
    finally:
        with contextlib.suppress(OSError):
            os.remove(report)

    with locked(path) as data:
        data["running"] = None
        record(data, {f: r for f, r in results.items() if f in files}, started, "auto")
        for f in files:
            entry = data["files"].get(f)
            if entry is None or entry["status"] != "running":
                continue
            # A file the run reached no testcase of: a timeout, or pytest failed before collecting it.
            entry["status"] = "stale" if entry.get("touchedAt", 0) > started else (status or "error")
            entry["ranAt"] = started
    return f"Reran {len(files)} test file(s)."


def view(data: dict) -> dict:
    """What the panel shows: files newest touched first, and the proposed tests."""
    files = sorted(data["files"].items(), key=lambda kv: kv[1].get("touchedAt", 0), reverse=True)
    return {
        "files": [{"path": f, "status": e.get("status", "not-run"), "passed": e.get("passed"),
                   "failed": e.get("failed"), "failing": e.get("failing", [])[:FAILING_SHOWN],
                   "moreFailing": max(0, len(e.get("failing", [])) - FAILING_SHOWN),
                   "atMs": int((e.get("ranAt") or e.get("touchedAt") or 0) * 1000)} for f, e in files],
        "proposed": data.get("proposed", []),
    }


STATUS_MARKS = {"passed": "✔", "failed": "✘", "running": "◌", "stale": "↻", "not-run": "?", "timeout": "⏱",
                "error": "!"}


def counts_text(entry: dict) -> str:
    """The result words for one file: "14 passed · 2 failed", or its status when there are no counts."""
    if entry["status"] in ("running", "not-run", "timeout", "error"):
        return {"running": "running…", "not-run": "not run", "timeout": "timed out", "error": "error"}[entry["status"]]
    parts = []
    if entry.get("passed") is not None:
        parts.append(f"{entry['passed']} passed")
    if entry.get("failed"):
        parts.append(f"{entry['failed']} failed")
    words = " · ".join(parts) or entry["status"]
    return words + (" (edited since)" if entry["status"] == "stale" else "")
