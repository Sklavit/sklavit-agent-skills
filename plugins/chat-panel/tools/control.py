#!/usr/bin/env python3
"""
Open, close and feed the side panel of a Claude Code session.

Usage:
    control.py hook              SessionStart hook: reads the hook JSON on stdin, opens the panel
    control.py open [session]    open the panel (no-op when it is already open)
    control.py close [session]   close the panel
    control.py status [session]  print whether the panel is open
    control.py summary [session] read a summary on stdin and show it in the panel
    control.py note [session]    read Markdown on stdin and add it to the panel's notes
    control.py clear-notes [session]  delete the panel's notes
    control.py recap [session]   read a one-line recap on stdin and add it to the panel's recaps
    control.py progress [session] [--allow-empty]  read the progress checklist on stdin and show it in the panel;
                                 with --allow-empty, an empty checklist removes it
    control.py data [session]    print the panel data as JSON (used by the native chat-panel mod)
    control.py tests-touch [session] <cwd>     read test file paths (JSON list) on stdin and mark them changed
    control.py tests-result [session] <cwd>    read {command, output} of a pytest run on stdin and store it
    control.py tests-proposed [session]        read proposed test names (JSON list) on stdin
    control.py tests-run [session] <cwd> [command] [file...]  rerun the changed (or the named) test files
    control.py headsup [session] read a one-line heads-up on stdin and show it in the panel's Heads up
    control.py commit-diff [session] <cwd>  print {key, text} of `git diff HEAD` (stat and capped diff) as JSON
    control.py commit [session]  read a draft commit message on stdin and show it in the panel

The session defaults to $CLAUDE_CODE_SESSION_ID. This script is the cmux side of the chat-panel mod
(~/.claude/skills/chat-panel): with the mod's mode set to cmux, the panel opens as a cmux split on the
right of the Claude pane; inside tmux as a tmux split; elsewhere the command to run is printed.
With mode native (the default) the mod draws the pane itself and only calls `data`.
Set CHAT_PANEL_AUTO=0 to stop the `hook` action from opening panels.
"""
import datetime
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time

import tests_tracker  # same directory

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(TOOL_DIR, "state")
PANEL = os.path.join(TOOL_DIR, "panel.py")
PYTHON = shutil.which("python3") or sys.executable
SPLIT_PERCENT = 35
SETTINGS = os.path.expanduser("~/.claude/settings.json")
RECAPS_SHOWN = 3
# The most diff text a commit draft sends to haiku.
DIFF_CHARS = 12000


def configured_mode() -> str:
    """The chat-panel mod's mode option from settings.json; "native" when unset."""
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            configs = json.load(f).get("pluginConfigs", {})
    except (OSError, ValueError):
        return "native"
    for key, config in configs.items():
        if key == "chat-panel" or key.startswith("chat-panel@"):
            return (config.get("options") or {}).get("mode", "native")
    return "native"


def panel_data(session_id: str) -> dict:
    """
    Collect what the panel shows. Reads only the transcript lines that hold a recap, and the
    branch from the transcript's tail, so a large transcript stays cheap to poll.
    """
    import panel  # same directory

    headline = panel.read_headline(session_id)
    summary = panel.read_summary(session_id)
    notes = panel.read_notes(session_id)
    progress = panel.read_progress(session_id)
    commit = panel.read_commit(session_id)
    recaps, branch = [], ""
    path = panel.find_transcript(session_id)
    if path:
        with open(path, "rb") as f:
            data = f.read()
        for raw in data.splitlines():
            if b'"away_summary"' not in raw and b'"command":"recap"' not in raw:
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            recap = panel.recap_text(rec)
            if recap:
                recaps.append((rec.get("timestamp", ""), recap[1], recap[0]))
        tail = data[-65536:]
        found = tail.rfind(b'"gitBranch":"')
        if found >= 0:
            start = found + len(b'"gitBranch":"')
            branch = tail[start:tail.find(b'"', start)].decode("utf-8", "replace")
    shown = list(reversed(panel.merge_recaps(recaps, session_id)[-RECAPS_SHOWN:]))
    return {
        "headline": {"tag": headline[0], "line": headline[1], "shownAt": headline[2], "isLive": headline[3]}
        if headline else None,
        "summary": {"text": summary[0], "mtimeMs": int(summary[1] * 1000)} if summary else None,
        "commit": {"text": commit[0], "mtimeMs": int(commit[1] * 1000)} if commit else None,
        "notes": {"text": notes[0], "mtimeMs": int(notes[1] * 1000)} if notes else None,
        "progress": {"text": progress[0], "mtimeMs": int(progress[1] * 1000)} if progress else None,
        "recaps": [{"at": at, "text": text, "source": source} for at, text, source in shown],
        "branch": branch,
        "tests": tests_tracker.view(tests_tracker.read(_state_path(session_id, "tests.json"))),
        "time": {"headline": panel.local_time(headline[2]) if headline else "",
                 "summary": panel.local_time(summary[1] * 1000) if summary else "",
                 "progress": panel.local_time(progress[1] * 1000) if progress else "",
                 "commit": panel.local_time(commit[1] * 1000) if commit else "",
                 "recaps": [panel.local_time(at) for at, _, _ in shown]},
    }


def git_diff(cwd: str) -> dict:
    """
    The changes against HEAD, staged or not, for a draft commit message. Untracked files are not in it.
    :param cwd: a directory inside the repository
    :return: {"key": hash of the full diff, "text": stat and diff, capped}; both "" with no change or no repository
    """
    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=20)

    try:
        stat = git("diff", "HEAD", "--stat")
        full = git("diff", "HEAD").stdout if stat.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        full = ""
    if not full.strip():
        return {"key": "", "text": ""}
    diff = full if len(full) <= DIFF_CHARS else full[:DIFF_CHARS] + "\n… (diff cut)"
    return {"key": hashlib.sha1(full.encode()).hexdigest(), "text": stat.stdout.strip() + "\n\n" + diff}


def _state_path(session_id: str, ext: str) -> str:
    return os.path.join(STATE_DIR, f"{session_id}.{ext}")


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def _pid_alive(session_id: str) -> int | None:
    pid = _read(_state_path(session_id, "pid"))
    if not pid or not pid.isdigit():
        return None
    try:
        os.kill(int(pid), 0)
    except OSError:
        return None
    return int(pid)


def _cmux() -> str | None:
    if not os.environ.get("CMUX_SOCKET_PATH"):
        return None
    return os.environ.get("CMUX_BUNDLED_CLI_PATH") or shutil.which("cmux")


def open_panel(session_id: str, quiet: bool = False) -> None:
    if _pid_alive(session_id):
        if not quiet:
            print("Panel is already open.")
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    command = f"{PYTHON} {PANEL} {session_id}"
    cmux = _cmux()
    if cmux:
        args = [cmux, "new-split", "right", "--command", command, "--focus", "false"]
        if os.environ.get("CMUX_SURFACE_ID"):
            args += ["--surface", os.environ["CMUX_SURFACE_ID"]]
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        refs = [w for w in result.stdout.split() if w.startswith("surface:")]
        if result.returncode != 0:
            if not quiet:
                print(f"cmux new-split failed: {result.stderr.strip() or result.stdout.strip()}")
            return
        with open(_state_path(session_id, "where"), "w") as f:
            json.dump({"kind": "cmux", "surface": refs[0] if refs else None}, f)
        if not quiet:
            print(f"Panel opened in cmux {refs[0] if refs else ''}".strip())
    elif os.environ.get("TMUX"):
        result = subprocess.run(["tmux", "split-window", "-h", "-d", "-l", f"{SPLIT_PERCENT}%", "-P",
                                 "-F", "#{pane_id}", command], capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            if not quiet:
                print(f"tmux split-window failed: {result.stderr.strip()}")
            return
        with open(_state_path(session_id, "where"), "w") as f:
            json.dump({"kind": "tmux", "pane": result.stdout.strip()}, f)
        if not quiet:
            print(f"Panel opened in tmux pane {result.stdout.strip()}")
    elif not quiet:
        print(f"Not in cmux or tmux. Run this in another terminal:\n  {command}")


def close_panel(session_id: str) -> None:
    where = json.loads(_read(_state_path(session_id, "where")) or "{}")
    if where.get("kind") == "cmux" and where.get("surface") and _cmux():
        subprocess.run([_cmux(), "close-surface", "--surface", where["surface"]], capture_output=True, timeout=10)
    elif where.get("kind") == "tmux" and where.get("pane"):
        subprocess.run(["tmux", "kill-pane", "-t", where["pane"]], capture_output=True, timeout=10)
    pid = _pid_alive(session_id)
    if pid:
        os.kill(pid, signal.SIGTERM)
    for ext in ("pid", "where"):
        try:
            os.remove(_state_path(session_id, ext))
        except OSError:
            pass
    print("Panel closed.")


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else "open"
    if action == "hook":
        # A SessionStart hook's stdout goes into the model context, so this path prints nothing.
        try:
            event = json.load(sys.stdin)
        except ValueError:
            return
        if os.environ.get("CHAT_PANEL_AUTO", "1") == "0" or event.get("source") == "compact":
            return
        if event.get("session_id"):
            try:
                open_panel(event["session_id"], quiet=True)
            except Exception:  # a hook must never break the session start
                pass
        return

    session_id = (sys.argv[2] if len(sys.argv) > 2 else None) or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not session_id:
        sys.exit("No session id: pass one or set CLAUDE_CODE_SESSION_ID.")
    if action == "open":
        open_panel(session_id)
    elif action == "close":
        close_panel(session_id)
    elif action == "status":
        print("open" if _pid_alive(session_id) else "closed")
    elif action == "summary":
        os.makedirs(STATE_DIR, exist_ok=True)
        text = sys.stdin.read().strip()
        with open(_state_path(session_id, "summary.md"), "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"Summary written ({len(text.splitlines())} lines).")
        if configured_mode() == "cmux":
            open_panel(session_id, quiet=True)
    elif action == "note":
        text = sys.stdin.read().strip()
        if text:
            os.makedirs(STATE_DIR, exist_ok=True)
            path = _state_path(session_id, "notes.md")
            separator = "\n\n---\n\n" if _read(path) else ""
            with open(path, "a", encoding="utf-8") as f:
                f.write(f"{separator}*{datetime.datetime.now():%d %b %H:%M}*\n\n{text}\n")
        print(f"Note saved to {_state_path(session_id, 'notes.md')}." if text else "Empty note ignored.")
    elif action == "clear-notes":
        try:
            os.remove(_state_path(session_id, "notes.md"))
        except OSError:
            pass
        print("Notes cleared.")
    elif action == "recap":
        text = " ".join(sys.stdin.read().split())
        if text:
            os.makedirs(STATE_DIR, exist_ok=True)
            at = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            with open(_state_path(session_id, "recaps.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": at, "text": text}) + "\n")
        print("Recap added." if text else "Empty recap ignored.")
    elif action == "progress":
        text = sys.stdin.read().strip()
        if text:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(_state_path(session_id, "progress.md"), "w", encoding="utf-8") as f:
                f.write(text + "\n")
        elif len(sys.argv) > 3 and sys.argv[3] == "--allow-empty":
            try:
                os.remove(_state_path(session_id, "progress.md"))
            except OSError:
                pass
        print(f"Progress written ({len(text.splitlines())} items)." if text else "Empty progress ignored.")
    elif action in ("tests-touch", "tests-result", "tests-proposed", "tests-run"):
        path = _state_path(session_id, "tests.json")
        cwd = sys.argv[3] if len(sys.argv) > 3 else os.getcwd()
        if action == "tests-run":
            command = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4].strip() else tests_tracker.DEFAULT_COMMAND
            only = sys.argv[5:] or None
            print(tests_tracker.run(path, cwd, command, only))
            return
        payload = json.loads(sys.stdin.read() or "null")
        with tests_tracker.locked(path) as data:
            if action == "tests-touch":
                tests_tracker.touch(data, payload or [], cwd, time.time())
            elif action == "tests-proposed":
                data["proposed"] = [str(p) for p in payload or []]
            else:
                files = tests_tracker.command_files(payload["command"])
                results = tests_tracker.parse_output(payload["output"], files)
                tests_tracker.record(data, results, time.time(), "claude")
        print("Tests updated.")
    elif action == "commit-diff":
        print(json.dumps(git_diff(sys.argv[3] if len(sys.argv) > 3 else os.getcwd())))
    elif action == "commit":
        text = sys.stdin.read().strip()
        if text:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(_state_path(session_id, "commit.md"), "w", encoding="utf-8") as f:
                f.write(text + "\n")
        print("Draft commit message written." if text else "Empty draft ignored.")
    elif action == "headsup":
        text = " ".join(sys.stdin.read().split())
        if text:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(_state_path(session_id, "headsup.json"), "w", encoding="utf-8") as f:
                json.dump([text, int(time.time() * 1000)], f)
        print("Heads-up written." if text else "Empty heads-up ignored.")
    elif action == "data":
        print(json.dumps(panel_data(session_id)))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
