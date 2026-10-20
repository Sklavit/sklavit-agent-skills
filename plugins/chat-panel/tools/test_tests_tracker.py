import sys

import tests_tracker as tt

OUTPUT_PLAIN = """============================= test session starts ==============================
collected 7 items

tests/unit_tests/api/test_auth_more.py ..F.                             [ 57%]
tests/unit_tests/api/test_folder.py ...                                  [100%]

=========================== short test summary info ============================
FAILED tests/unit_tests/api/test_auth_more.py::test_login_expired - assert 401 == 200
========================= 1 failed, 6 passed in 2.31s ==========================
"""

OUTPUT_XDIST = """created: 8/8 workers
8 workers [5 items]
..F..
FAILED tests/unit_tests/api/test_auth_more.py::test_login_expired - assert 401 == 200
========================= 1 failed, 4 passed in 3.10s ==========================
"""


def test_test_paths():
    assert tt.is_test_path("tests/unit_tests/api/test_auth.py")
    assert tt.is_test_path("/repo/src/thing_test.py")
    assert not tt.is_test_path("tests/unit_tests/api/conftest.py")
    assert not tt.is_test_path("src/api/routes.py")


def test_progress_lines_give_per_file_counts():
    results = tt.parse_output(OUTPUT_PLAIN, [])
    assert results["tests/unit_tests/api/test_auth_more.py"] == {"passed": 3, "failed": 1, "failing": ["test_login_expired"]}
    assert results["tests/unit_tests/api/test_folder.py"] == {"passed": 3, "failed": 0, "failing": []}


def test_xdist_output_with_one_file_uses_the_summary():
    results = tt.parse_output(OUTPUT_XDIST, ["tests/unit_tests/api/test_auth_more.py"])
    assert results["tests/unit_tests/api/test_auth_more.py"] == {"passed": 4, "failed": 1, "failing": ["test_login_expired"]}


def test_xdist_output_with_several_files_and_no_failure_marks_them_passed():
    output = "..\n========================= 2 passed in 1.0s ==========================\n"
    results = tt.parse_output(output, ["tests/a/test_x.py", "tests/a/test_y.py"])
    assert results == {"tests/a/test_x.py": {"passed": None, "failed": 0, "failing": []},
                       "tests/a/test_y.py": {"passed": None, "failed": 0, "failing": []}}


def test_command_files_cut_node_ids():
    assert tt.command_files("uv run pytest tests/a/test_x.py::test_one tests/b/ --no-cov") == ["tests/a/test_x.py"]


def test_touch_record_and_stale():
    data = tt.empty()
    tt.touch(data, ["/repo/tests/a/test_x.py", "/repo/src/routes.py"], "/repo", 100.0)
    assert list(data["files"]) == ["tests/a/test_x.py"]
    assert data["files"]["tests/a/test_x.py"]["status"] == "not-run"
    tt.record(data, {"tests/a/test_x.py": {"passed": 2, "failed": 1, "failing": ["test_b"]}}, 110.0, "claude")
    assert data["files"]["tests/a/test_x.py"]["status"] == "failed"
    tt.touch(data, ["tests/a/test_x.py"], "/repo", 120.0)
    assert data["files"]["tests/a/test_x.py"]["status"] == "stale"
    tt.record(data, {"tests/a/test_x.py": {"passed": 3, "failed": 0, "failing": []}}, 115.0, "auto")
    assert data["files"]["tests/a/test_x.py"]["status"] == "stale"  # edited during the run


def test_record_ignores_untracked_files():
    data = tt.empty()
    tt.record(data, {"tests/a/test_x.py": {"passed": 1, "failed": 0, "failing": []}}, 1.0, "claude")
    assert data["files"] == {}


def test_junit_report():
    xml = """<testsuites><testsuite>
      <testcase file="tests/a/test_x.py" name="test_ok"/>
      <testcase file="tests/a/test_x.py" name="test_bad"><failure message="x"/></testcase>
      <testcase file="tests/a/test_x.py" name="test_skip"><skipped/></testcase>
      <testcase file="tests/a/test_y.py" name="test_err"><error message="x"/></testcase>
    </testsuite></testsuites>"""
    assert tt.parse_junit(xml) == {"tests/a/test_x.py": {"passed": 1, "failed": 1, "failing": ["test_bad"]},
                                   "tests/a/test_y.py": {"passed": 0, "failed": 1, "failing": ["test_err"]}}


def test_due_skips_unchanged_running_and_missing_files(tmp_path):
    (tmp_path / "tests").mkdir()
    for name in ("test_new.py", "test_ran.py", "test_run.py"):
        (tmp_path / "tests" / name).write_text("")
    data = {"files": {
        "tests/test_new.py": {"status": "not-run", "touchedAt": 5, "ranAt": None},
        "tests/test_ran.py": {"status": "passed", "touchedAt": 5, "ranAt": 6},
        "tests/test_run.py": {"status": "running", "touchedAt": 5, "ranAt": None},
        "tests/test_gone.py": {"status": "not-run", "touchedAt": 5, "ranAt": None},
    }, "proposed": [], "running": None}
    assert tt.due(data, str(tmp_path)) == ["tests/test_new.py"]


def test_run_executes_pytest_and_records_results(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_demo.py").write_text("def test_ok():\n    assert True\n\ndef test_bad():\n    assert False\n")
    state = str(tmp_path / "state" / "s.tests.json")
    with tt.locked(state) as data:
        tt.touch(data, [str(tmp_path / "tests" / "test_demo.py")], str(tmp_path), 1.0)
    command = f"{sys.executable} -m pytest"
    assert tt.run(state, str(tmp_path), command) == "Reran 1 test file(s)."
    entry = tt.read(state)["files"]["tests/test_demo.py"]
    assert (entry["status"], entry["passed"], entry["failed"], entry["failing"]) == ("failed", 1, 1, ["test_bad"])
    assert tt.run(state, str(tmp_path), command) == "Nothing to rerun."


def test_counts_text():
    assert tt.counts_text({"status": "failed", "passed": 14, "failed": 2}) == "14 passed · 2 failed"
    assert tt.counts_text({"status": "passed", "passed": None, "failed": 0}) == "passed"
    assert tt.counts_text({"status": "stale", "passed": 3, "failed": 0}) == "3 passed (edited since)"
    assert tt.counts_text({"status": "running", "passed": None, "failed": None}) == "running…"


def test_run_named_files_reruns_an_unchanged_file(tmp_path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_demo.py").write_text("def test_ok():\n    assert True\n")
    state = str(tmp_path / "state" / "s.tests.json")
    with tt.locked(state) as data:
        tt.touch(data, ["tests/test_demo.py"], str(tmp_path), 1.0)
    command = f"{sys.executable} -m pytest"
    tt.run(state, str(tmp_path), command)
    assert tt.run(state, str(tmp_path), command) == "Nothing to rerun."
    assert tt.run(state, str(tmp_path), command, ["tests/test_demo.py", "tests/test_other.py"]) == "Reran 1 test file(s)."
    assert tt.read(state)["files"]["tests/test_demo.py"]["status"] == "passed"
