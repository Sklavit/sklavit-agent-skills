#!/usr/bin/env python3
"""
Side panel for one Claude Code session. Shows, newest first:
- the you-should-know headline for the session (the last one stays, dimmed, after it is dismissed)
- the summary written by /summary
- the progress checklist the chat-panel mod writes after each turn (state/<session>.progress.md)
- the notes saved with /note (state/<session>.notes.md)
- the test files the session touched and their last results (state/<session>.tests.json)
- the latest recaps: /recap and away recaps from the transcript, and the per-turn recaps the
  chat-panel mod writes to state/<session>.recaps.jsonl

Usage: python3 panel.py <session-id>
Stdlib only. Redraws when a source file changes or the pane is resized. Ctrl-C to quit.
"""
import datetime
import glob
import json
import os
import re
import shutil
import sys
import textwrap
import time

import tests_tracker  # same directory

HOME = os.path.expanduser("~")
TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(TOOL_DIR, "state")
YSK_GLOB = os.path.join(HOME, ".claude/plugins/store/cc-plugin-you-should-know_*.json")
RECAPS_SHOWN = 3
POLL_S = 1.0

BOLD, DIM, RESET = "\033[1m", "\033[2m", "\033[0m"
YELLOW, CYAN, GREEN, MAGENTA, BLUE, RED = "\033[33m", "\033[36m", "\033[32m", "\033[35m", "\033[34m", "\033[31m"
CLEAR = "\033[H\033[2J\033[3J"


def find_transcript(session_id: str) -> str | None:
    matches = glob.glob(os.path.join(HOME, ".claude/projects/*", f"{session_id}.jsonl"))
    return max(matches, key=os.path.getmtime) if matches else None


def local_time(value) -> str:
    """Format an ISO string or epoch milliseconds as local HH:MM, with the date when not today."""
    try:
        if isinstance(value, (int, float)):
            dt = datetime.datetime.fromtimestamp(value / 1000)
        else:
            dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
    except (TypeError, ValueError):
        return ""
    return dt.strftime("%H:%M") if dt.date() == datetime.date.today() else dt.strftime("%d %b %H:%M")


RECAP_STDOUT = re.compile(r"^<local-command-stdout>(.*)</local-command-stdout>$", re.S)


def recap_text(rec: dict) -> tuple[str, str] | None:
    """
    Return (source, text) when a transcript record holds a recap, else None.
    An away recap is an away_summary record; a typed /recap is a local_command record
    whose content wraps the text in <local-command-stdout> tags.
    """
    if rec.get("type") != "system":
        return None
    content = rec.get("content")
    if not isinstance(content, str) or not content:
        return None
    if rec.get("subtype") == "away_summary":
        return "away", content
    if rec.get("subtype") == "local_command" and (rec.get("commandRun") or {}).get("command") == "recap":
        match = RECAP_STDOUT.match(content.strip())
        text = (match.group(1) if match else content).strip()
        return ("recap", text) if text else None
    return None


def read_auto_recaps(session_id: str) -> list[tuple[str, str, str]]:
    """Return (timestamp, text, "auto") for each per-turn recap the mod appended."""
    recaps = []
    try:
        with open(os.path.join(STATE_DIR, f"{session_id}.recaps.jsonl"), encoding="utf-8") as f:
            for raw in f:
                try:
                    rec = json.loads(raw)
                except ValueError:
                    continue
                if rec.get("text"):
                    recaps.append((rec.get("at", ""), rec["text"], "auto"))
    except OSError:
        pass
    return recaps


def merge_recaps(transcript_recaps: list[tuple[str, str, str]], session_id: str) -> list[tuple[str, str, str]]:
    """All recaps of the session, oldest first, by their ISO timestamps."""
    return sorted(transcript_recaps + read_auto_recaps(session_id), key=lambda r: r[0])


class Transcript:
    """Reads the transcript incrementally and keeps the recaps and the latest branch."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.path = None
        self.offset = 0
        self.recaps: list[tuple[str, str, str]] = []
        self.branch = ""

    def update(self) -> bool:
        if self.path is None:
            self.path = find_transcript(self.session_id)
            if self.path is None:
                return False
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return False
        if size < self.offset:
            self.offset, self.recaps = 0, []
        if size == self.offset:
            return False
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read()
        end = data.rfind(b"\n") + 1  # leave a half-written last line for the next poll
        self.offset += end
        changed = False
        for raw in data[:end].splitlines():
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if rec.get("gitBranch") and rec["gitBranch"] != self.branch:
                self.branch, changed = rec["gitBranch"], True
            recap = recap_text(rec)
            if recap:
                self.recaps.append((rec.get("timestamp", ""), recap[1], recap[0]))
                changed = True
        return changed


def read_headline(session_id: str) -> tuple[str, str, int, bool] | None:
    """
    Return (tag, headline, shown_at_ms, is_live) of the newer of the you-should-know headline and the
    heads-up the chat-panel mod generated (state/<session>.headsup.json).
    """
    ysk = read_ysk_headline(session_id)
    try:
        with open(os.path.join(STATE_DIR, f"{session_id}.headsup.json"), encoding="utf-8") as f:
            line, shown = json.load(f)
        own = ("chat-panel", line, shown, True)
    except (OSError, ValueError, TypeError):
        own = None
    return max((h for h in (ysk, own) if h), key=lambda h: h[2], default=None)


def read_ysk_headline(session_id: str) -> tuple[str, str, int, bool] | None:
    """
    Return (tag, headline, shown_at_ms, is_live) of the you-should-know view for the session.
    you-should-know clears its view once the line is dismissed, so each live view is cached in
    state/<session>.headline.json and the cached one comes back with is_live False.
    """
    cache = os.path.join(STATE_DIR, f"{session_id}.headline.json")
    live = _read_live_headline(session_id)
    if live:
        cached = None
        try:
            with open(cache, encoding="utf-8") as f:
                cached = json.load(f)
        except (OSError, ValueError):
            pass
        if cached != list(live):
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(cache, "w", encoding="utf-8") as f:
                json.dump(list(live), f)
        return (*live, True)
    try:
        with open(cache, encoding="utf-8") as f:
            tag, line, shown = json.load(f)
        return tag, line, shown, False
    except (OSError, ValueError, TypeError):
        return None


def _read_live_headline(session_id: str) -> tuple[str, str, int] | None:
    """Return (tag, headline, shown_at_ms) of the you-should-know view while it is shown."""
    for path in glob.glob(YSK_GLOB):
        try:
            with open(path, encoding="utf-8") as f:
                sessions = json.load(f).get("sessions", [])
        except (OSError, ValueError):
            continue
        for s in sessions:
            view = s.get("view") or {}
            if s.get("id") == session_id and view.get("line"):
                return s.get("tag", ""), view["line"], view.get("shownAt", 0)
    return None


def read_summary(session_id: str) -> tuple[str, float] | None:
    path = os.path.join(STATE_DIR, f"{session_id}.summary.md")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip(), os.path.getmtime(path)
    except OSError:
        return None


def read_notes(session_id: str) -> tuple[str, float] | None:
    """The notes saved with `control.py note`, oldest first, or None when there are none."""
    path = os.path.join(STATE_DIR, f"{session_id}.notes.md")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        return (text, os.path.getmtime(path)) if text else None
    except OSError:
        return None


def read_commit(session_id: str) -> tuple[str, float] | None:
    """The draft commit message written with `control.py commit`, or None when there is none."""
    path = os.path.join(STATE_DIR, f"{session_id}.commit.md")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        return (text, os.path.getmtime(path)) if text else None
    except OSError:
        return None


def read_progress(session_id: str) -> tuple[str, float] | None:
    """The checklist written with `control.py progress`, or None when there is none."""
    path = os.path.join(STATE_DIR, f"{session_id}.progress.md")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        return (text, os.path.getmtime(path)) if text else None
    except OSError:
        return None


PROGRESS_MARKS = {"[x] ": ("✔ ", DIM), "[>] ": ("▶ ", BOLD), "[ ] ": ("☐ ", ""), "[i] ": ("• ", "")}


def progress_lines(text: str, width: int) -> list[str]:
    """The checklist with a mark per status: done dimmed, in progress bold; the findings under their own heading."""
    lines = []
    previous = ""
    for item in text.splitlines():
        if item.startswith("[i] ") and not previous.startswith("[i] "):
            lines.append(f"{BOLD}ⓘ Findings{RESET}")
        previous = item
        mark, style = PROGRESS_MARKS.get(item[:4], ("", ""))
        body = item[4:] if mark else item
        wrapped = textwrap.wrap(body, width, initial_indent=mark, subsequent_indent="  ") or [""]
        lines += [style + line + RESET for line in wrapped]
    return lines


def tests_lines(tests: dict, width: int) -> list[str]:
    """The Tests section body: one line per file, failing tests under it, then the proposed tests."""
    lines = []
    for f in tests["files"]:
        mark = tests_tracker.STATUS_MARKS.get(f["status"], "?")
        style = RED if f["status"] in ("failed", "error", "timeout") else GREEN if f["status"] == "passed" else DIM
        lines.append(f"{style}{mark}{RESET} {f['path']}")
        lines.append(f"  {DIM}{tests_tracker.counts_text(f)} · {local_time(f['atMs'])}{RESET}")
        names = f["failing"] + ([f"+{f['moreFailing']} more"] if f["moreFailing"] else [])
        lines += textwrap.wrap(" · ".join(names), width, initial_indent="    ", subsequent_indent="    ") if names else []
    for name in tests["proposed"]:
        lines.append(f"{DIM}✎ {name} (proposed){RESET}")
    return lines


def markdown_bold(line: str) -> str:
    return re.sub(r"\*\*(.+?)\*\*", BOLD + r"\1" + RESET, line)


def wrap(text: str, width: int, indent: str = "") -> list[str]:
    """Wrap text to the width, keep "- " bullets, and show **bold** in bold. Wraps before styling."""
    lines = []
    for para in text.splitlines() or [""]:
        bullet = para[:2] if para.startswith(("- ", "* ")) else ""
        body = para[len(bullet):]
        first = indent + ("• " if bullet else "")
        rest = indent + ("  " if bullet else "")
        lines += textwrap.wrap(body, width, initial_indent=first, subsequent_indent=rest) or [""]
    return [markdown_bold(line) for line in lines]


def render(session_id: str, transcript: Transcript, headline, summary, notes=None, progress=None, tests=None,
           commit=None) -> str:
    cols, _ = shutil.get_terminal_size((50, 40))
    width = max(cols - 2, 20)
    rule = DIM + "─" * width + RESET
    out = []

    out.append(f"{BOLD}{YELLOW}⚑ Heads up{RESET}")
    if headline:
        tag, line, shown, is_live = headline
        label = " · ".join(x for x in (tag, local_time(shown), "" if is_live else "dismissed") if x)
        out.append(f"{DIM}{label}{RESET}")
        out += wrap(line, width) if is_live else [DIM + x + RESET for x in wrap(line, width)]
    else:
        out.append(f"{DIM}none yet{RESET}")
    out.append(rule)

    out.append(f"{BOLD}{GREEN}≡ Summary{RESET}")
    if summary:
        text, mtime = summary
        out.append(f"{DIM}{local_time(mtime * 1000)}{RESET}")
        out += wrap(text, width)
    else:
        out.append(f"{DIM}run /summary{RESET}")
    out.append(rule)

    out.append(f"{BOLD}{GREEN}✉ Draft commit message{RESET}")
    if commit:
        out.append(f"{DIM}{local_time(commit[1] * 1000)}{RESET}")
        for line in commit[0].splitlines():
            out += wrap(line, width) or [""]
    else:
        out.append(f"{DIM}none yet{RESET}")
    out.append(rule)

    if progress:
        out.append(f"{BOLD}{BLUE}☑ Progress{RESET}")
        out.append(f"{DIM}{local_time(progress[1] * 1000)}{RESET}")
        out += progress_lines(progress[0], width)
        out.append(rule)

    if tests and (tests["files"] or tests["proposed"]):
        out.append(f"{BOLD}{RED}⚗ Tests{RESET}")
        out += tests_lines(tests, width)
        out.append(rule)

    if notes:
        out.append(f"{BOLD}{MAGENTA}✎ Notes{RESET}")
        out += wrap(notes[0], width)
        out.append(rule)

    out.append(f"{BOLD}{CYAN}↺ Recaps{RESET}")
    recaps = merge_recaps(transcript.recaps, session_id)
    if recaps:
        for ts, text, source in reversed(recaps[-RECAPS_SHOWN:]):
            out.append(f"{DIM}{local_time(ts)} · {source}{RESET}")
            out += wrap(text, width)
            out.append("")
    else:
        out.append(f"{DIM}none yet{RESET}")
    out.append(rule)

    where = transcript.branch or "?"
    out.append(f"{DIM}{session_id[:8]} · {where} · {datetime.datetime.now():%H:%M:%S}{RESET}")
    return "\n".join(out)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    session_id = sys.argv[1]
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(os.path.join(STATE_DIR, f"{session_id}.pid"), "w") as f:
        f.write(str(os.getpid()))
    sys.stdout.write(f"\033]0;panel {session_id[:8]}\007")  # tab title

    transcript = Transcript(session_id)
    last_key = None
    try:
        while True:
            transcript.update()
            headline = read_headline(session_id)
            summary = read_summary(session_id)
            notes = read_notes(session_id)
            progress = read_progress(session_id)
            commit = read_commit(session_id)
            tests = tests_tracker.view(tests_tracker.read(os.path.join(STATE_DIR, f"{session_id}.tests.json")))
            size = shutil.get_terminal_size((50, 40))
            auto = read_auto_recaps(session_id)
            key = (len(transcript.recaps), len(auto), transcript.branch, headline, summary, notes, progress, commit, json.dumps(tests), size, time.strftime("%H:%M"))
            if key != last_key:
                sys.stdout.write(CLEAR + render(session_id, transcript, headline, summary, notes, progress, tests, commit) + "\n")
                sys.stdout.flush()
                last_key = key
            time.sleep(POLL_S)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
