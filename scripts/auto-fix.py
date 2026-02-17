#!/usr/bin/env python3
"""
Codex auto-fix runner for BookScanner rejects.

Modes:
1. TRIAGE: classify whether rejects are likely code-fixable vs OCR-only
2. FIX: run `codex exec` non-interactively with rejects context and send status updates
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import shutil
import re
import signal
from pathlib import Path
from typing import Any


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = Path(os.environ.get("BOOKSCANNER_PROJECT_DIR", str(SCRIPT_PATH.parent.parent))).resolve()
LEGACY_HOME = Path.home() / ".claude" / "clawdbot-instructions"
CODEX_HOME = Path.home() / ".claude" / "codex-bookscanner-loop"


def resolve_automation_home() -> Path:
    explicit_home = os.environ.get("BOOKSCANNER_AUTOMATION_HOME")
    if explicit_home:
        return Path(explicit_home).expanduser().resolve()

    profile = os.environ.get("BOOKSCANNER_AUTOMATION_PROFILE", "auto").strip().lower()
    if profile == "legacy":
        return LEGACY_HOME
    if profile == "codex":
        return CODEX_HOME
    if LEGACY_HOME.exists():
        return LEGACY_HOME
    return CODEX_HOME


AUTOMATION_HOME = resolve_automation_home()
LOCK_FILE = AUTOMATION_HOME / ".codex_auto_fix.lock"
STATE_FILE = AUTOMATION_HOME / ".codex_auto_fix_state.json"
LAST_MESSAGE_FILE = AUTOMATION_HOME / "codex_last_fix_message.txt"
LAST_CODEX_OUTPUT_FILE = AUTOMATION_HOME / "codex_last_fix_output.log"
SEND_SCRIPT = AUTOMATION_HOME / "telegram-bot" / "send.py"
ACTIVE_AGENT_PROCESS: Any = None


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_lock() -> bool:
    AUTOMATION_HOME.mkdir(parents=True, exist_ok=True)

    if LOCK_FILE.exists():
        try:
            existing_pid = int(LOCK_FILE.read_text().strip())
            if pid_alive(existing_pid):
                print(f"[auto-fix] lock active pid={existing_pid}; skipping")
                return False
        except Exception:
            pass
        try:
            LOCK_FILE.unlink()
        except Exception:
            pass

    LOCK_FILE.write_text(str(os.getpid()))
    return True


def release_lock() -> None:
    try:
        if LOCK_FILE.exists():
            LOCK_FILE.unlink()
    except Exception:
        pass


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict[str, Any]) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2))
    except Exception as e:
        print(f"[auto-fix] failed to save state: {e}")


def send_telegram(message: str) -> None:
    if not SEND_SCRIPT.exists():
        return
    try:
        subprocess.run(
            ["python3", str(SEND_SCRIPT)],
            input=message,
            text=True,
            capture_output=True,
            timeout=30,
        )
    except Exception as e:
        print(f"[auto-fix] telegram send failed: {e}")


def terminate_active_agent_process(force: bool = False) -> None:
    global ACTIVE_AGENT_PROCESS
    proc = ACTIVE_AGENT_PROCESS
    if proc is None:
        return

    try:
        if proc.poll() is not None:
            ACTIVE_AGENT_PROCESS = None
            return
    except Exception:
        ACTIVE_AGENT_PROCESS = None
        return

    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass

    wait_timeout = 8 if force else 12
    try:
        proc.wait(timeout=wait_timeout)
    except Exception:
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    finally:
        ACTIVE_AGENT_PROCESS = None


def handle_shutdown_signal(signum: int, _frame: Any) -> None:
    try:
        signame = signal.Signals(signum).name
    except Exception:
        signame = str(signum)
    print(f"[auto-fix] received signal {signame}; terminating active agent process")
    terminate_active_agent_process(force=True)
    raise SystemExit(128 + signum)


for sig in (signal.SIGTERM, signal.SIGINT):
    try:
        signal.signal(sig, handle_shutdown_signal)
    except Exception:
        pass


def load_rejects(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def sanitize_text(value: Any) -> str:
    return str(value or "").strip()


def alnum_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9]", text))


def normalize_reason(reason: str) -> str:
    lowered = sanitize_text(reason).lower()
    if not lowered:
        return "unknown"
    return lowered


def triage_payload(payload: dict[str, Any]) -> dict[str, Any]:
    rejects = payload.get("rejects", []) or []
    reason_counts: dict[str, int] = {}
    no_text_count = 0
    no_hypotheses_count = 0
    low_confidence_count = 0
    fixable_signal_count = 0
    ocr_only_signal_count = 0

    for item in rejects:
        merged_text = sanitize_text(item.get("mergedText"))
        reason = normalize_reason(item.get("resolverDecisionReason"))
        reason_counts[reason] = reason_counts.get(reason, 0) + 1

        evidence = item.get("evidenceSearchDebug") or {}
        hypothesis_count = int(
            evidence.get("hypothesesCount", evidence.get("hypothesesTried", 0)) or 0
        )
        queries_tried_count = int(evidence.get("queriesTriedCount", 0) or 0)
        top_score = evidence.get("topScores", [{}])
        top_score_value = 0.0
        if isinstance(top_score, list) and top_score:
            top_candidate = top_score[0] or {}
            top_score_value = float(
                top_candidate.get("finalScore", top_candidate.get("score", 0.0)) or 0.0
            )

        text_is_weak = alnum_count(merged_text) < 4
        if text_is_weak:
            no_text_count += 1

        no_hypotheses = hypothesis_count == 0 and queries_tried_count == 0
        if no_hypotheses:
            no_hypotheses_count += 1

        low_confidence = "low_title_confidence" in reason or top_score_value < 0.45
        if low_confidence:
            low_confidence_count += 1

        has_fixable_signal = any(
            token in reason
            for token in (
                "low_title_confidence",
                "low_author_confidence",
                "no candidates found",
                "no_candidates",
                "weak_title",
                "manual_review",
            )
        ) or no_hypotheses
        has_ocr_only_signal = any(
            token in reason
            for token in (
                "no_evidence",
                "ocr",
                "empty text",
                "no_text",
            )
        ) or (text_is_weak and not has_fixable_signal)

        if has_fixable_signal:
            fixable_signal_count += 1
        if has_ocr_only_signal:
            ocr_only_signal_count += 1

    reject_count = int(payload.get("rejectCount", len(rejects) or 0))
    has_rejects = reject_count > 0
    fixable = has_rejects and fixable_signal_count > 0
    primarily_ocr = has_rejects and ocr_only_signal_count >= max(1, int(0.8 * reject_count))

    recommendation = "proceed_fix"
    if not has_rejects:
        recommendation = "skip_no_rejects"
    elif not fixable and primarily_ocr:
        recommendation = "ocr_pipeline_first"
    elif not fixable:
        recommendation = "manual_investigation"

    top_reasons = sorted(reason_counts.items(), key=lambda x: x[1], reverse=True)[:6]
    return {
        "ok": True,
        "hasRejects": has_rejects,
        "fixable": fixable,
        "primarilyOCR": primarily_ocr,
        "recommendation": recommendation,
        "rejectCount": reject_count,
        "fixableSignals": fixable_signal_count,
        "ocrOnlySignals": ocr_only_signal_count,
        "noTextCount": no_text_count,
        "noHypothesesCount": no_hypotheses_count,
        "lowConfidenceCount": low_confidence_count,
        "topReasons": [{"reason": reason, "count": count} for reason, count in top_reasons],
    }


def fingerprint_rejects(payload: dict[str, Any]) -> str:
    rejects = payload.get("rejects", [])
    rows: list[str] = []
    for item in rejects:
        row = "|".join(
            [
                str(item.get("id", "")),
                str(item.get("resolverDecisionReason", "")),
                str(item.get("mergedText", ""))[:160],
            ]
        )
        rows.append(row)
    rows.sort()
    digest = hashlib.sha1("\n".join(rows).encode("utf-8")).hexdigest()
    return digest


def should_debounce(payload: dict[str, Any], state: dict[str, Any]) -> bool:
    if os.environ.get("BOOKSCANNER_AUTOFIX_DISABLE_DEBOUNCE", "0") == "1":
        return False

    cooldown_sec = int(os.environ.get("BOOKSCANNER_AUTOFIX_COOLDOWN_SEC", "180"))
    current_fp = fingerprint_rejects(payload)
    current_session = str(payload.get("sessionId", "unknown"))
    current_reject_count = int(payload.get("rejectCount", len(payload.get("rejects", [])) or 0))

    last_fp = str(state.get("lastFingerprint", ""))
    last_session = str(state.get("lastSessionId", ""))
    last_reject_count = int(state.get("lastRejectCount", -1))
    last_ts = float(state.get("lastRunEpochSec", 0))

    within_cooldown = (time.time() - last_ts) < cooldown_sec
    same_payload = (
        current_fp == last_fp
        and current_session == last_session
        and current_reject_count == last_reject_count
    )
    return within_cooldown and same_payload


def normalize_repo_path(path_value: str) -> str:
    return path_value.strip().replace("\\", "/").lstrip("./")


def parse_git_status_entries() -> list[dict[str, str]]:
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception:
        return []

    entries: list[dict[str, str]] = []
    for raw in result.stdout.splitlines():
        if len(raw) < 4:
            continue
        status = raw[:2]
        path_part = raw[3:].strip()
        if " -> " in path_part:
            path_part = path_part.split(" -> ", 1)[1].strip()
        normalized = normalize_repo_path(path_part)
        if not normalized:
            continue
        entries.append({"status": status, "path": normalized})
    return entries


def git_changed_files() -> list[str]:
    try:
        return [entry["path"] for entry in parse_git_status_entries()]
    except Exception:
        return []


def parse_allowed_autofix_files() -> set[str]:
    configured = os.environ.get("BOOKSCANNER_AUTOFIX_ALLOWED_FILES")
    if configured is not None:
        raw = configured.strip()
        if raw.lower() in {"*", "all", "any"}:
            return set()
        parsed = {
            normalize_repo_path(part)
            for part in re.split(r"[,\n;]+", raw)
            if part.strip()
        }
        return {path for path in parsed if path}

    profile = os.environ.get("BOOKSCANNER_AUTOMATION_PROFILE", "auto").strip().lower()
    if profile == "codex":
        return {"src/services/queryHypotheses.ts"}
    return set()


def build_fix_scope_note(allowed_files: set[str]) -> str:
    if not allowed_files:
        return ""

    allowed_list = "\n".join(
        f"- {path}" for path in sorted(allowed_files)
    )
    return (
        "Edit scope constraint:\n"
        "You may modify only the following file(s):\n"
        f"{allowed_list}\n"
        "If a fix is not possible within this scope, explain briefly and do not touch other files.\n"
    )


def is_path_inside_repo(path_obj: Path) -> bool:
    try:
        path_obj.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except Exception:
        return False


def is_tracked_file(rel_path: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", rel_path],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        return result.returncode == 0
    except Exception:
        return False


def revert_out_of_scope_paths(paths: list[str]) -> tuple[list[str], list[str]]:
    reverted: list[str] = []
    failed: list[str] = []

    for rel_path in sorted(set(paths)):
        normalized = normalize_repo_path(rel_path)
        if not normalized:
            continue
        abs_path = (REPO_ROOT / normalized).resolve()
        if not is_path_inside_repo(abs_path):
            failed.append(normalized)
            continue

        try:
            if is_tracked_file(normalized):
                subprocess.run(
                    ["git", "checkout", "--", normalized],
                    cwd=str(REPO_ROOT),
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=True,
                )
            else:
                if abs_path.is_dir():
                    shutil.rmtree(abs_path)
                elif abs_path.exists():
                    abs_path.unlink()
            reverted.append(normalized)
        except Exception:
            failed.append(normalized)

    return reverted, failed


def snapshot_paths(paths: list[str]) -> dict[str, dict[str, Any]]:
    snapshots: dict[str, dict[str, Any]] = {}

    for rel_path in sorted(set(paths)):
        normalized = normalize_repo_path(rel_path)
        if not normalized:
            continue

        abs_path = (REPO_ROOT / normalized).resolve()
        if not is_path_inside_repo(abs_path):
            continue

        entry: dict[str, Any] = {"path": normalized, "kind": "missing"}
        try:
            if abs_path.exists():
                if abs_path.is_file():
                    entry["kind"] = "file"
                    entry["content"] = abs_path.read_bytes()
                elif abs_path.is_dir():
                    entry["kind"] = "dir"
                else:
                    entry["kind"] = "other"
            snapshots[normalized] = entry
        except Exception:
            entry["kind"] = "error"
            snapshots[normalized] = entry

    return snapshots


def snapshot_entry_changed(entry: dict[str, Any]) -> bool:
    path = normalize_repo_path(str(entry.get("path", "")))
    if not path:
        return False

    abs_path = (REPO_ROOT / path).resolve()
    if not is_path_inside_repo(abs_path):
        return False

    kind = str(entry.get("kind", "missing"))
    try:
        if kind == "missing":
            return abs_path.exists()
        if kind == "file":
            if not abs_path.exists() or not abs_path.is_file():
                return True
            return abs_path.read_bytes() != (entry.get("content") or b"")
        if kind == "dir":
            return not abs_path.exists() or not abs_path.is_dir()
    except Exception:
        return True

    return False


def restore_paths_from_snapshots(
    snapshots: dict[str, dict[str, Any]], paths: list[str]
) -> tuple[list[str], list[str]]:
    restored: list[str] = []
    failed: list[str] = []

    for rel_path in sorted(set(paths)):
        normalized = normalize_repo_path(rel_path)
        if not normalized:
            continue

        snapshot = snapshots.get(normalized)
        if not snapshot:
            failed.append(normalized)
            continue

        abs_path = (REPO_ROOT / normalized).resolve()
        if not is_path_inside_repo(abs_path):
            failed.append(normalized)
            continue

        kind = str(snapshot.get("kind", "missing"))
        try:
            if kind == "missing":
                if abs_path.is_dir():
                    shutil.rmtree(abs_path)
                elif abs_path.exists():
                    abs_path.unlink()
            elif kind == "file":
                content = snapshot.get("content")
                if not isinstance(content, (bytes, bytearray)):
                    failed.append(normalized)
                    continue
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                abs_path.write_bytes(bytes(content))
            elif kind == "dir":
                abs_path.mkdir(parents=True, exist_ok=True)
            else:
                failed.append(normalized)
                continue

            restored.append(normalized)
        except Exception:
            failed.append(normalized)

    return restored, failed


def git_diff_fingerprint() -> str:
    try:
        result = subprocess.run(
            ["git", "diff"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return hashlib.sha1(result.stdout.encode("utf-8")).hexdigest()
    except Exception:
        return ""


def build_prompt(rejects_file: Path, payload: dict[str, Any], allowed_files: set[str]) -> str:
    session_id = payload.get("sessionId", "unknown")
    reject_count = payload.get("rejectCount", len(payload.get("rejects", [])) or 0)
    total_books = payload.get("totalBooks", "?")
    scope_note = build_fix_scope_note(allowed_files)
    return f"""You are fixing BookScanner metadata resolution quality.

Rejects JSON: {rejects_file}
Rejected: {reject_count}/{total_books}

Steps:
1. Read the rejects JSON. There are {reject_count} rejected books.
2. For each reject, look at mergedText and resolverDecisionReason.
3. Apply minimal, generic fixes to the codebase.
4. Do NOT commit. Do NOT run tests.
5. Return a short summary of what you changed.

{scope_note}

Keep changes minimal and safe.
"""


def resolve_agent_bin() -> tuple[str, str]:
    """Resolve agent binary and type. Returns (binary_path, agent_type).
    agent_type is 'claude' or 'codex'.
    """
    agent_type = os.environ.get("BOOKSCANNER_AGENT_TYPE", "").strip().lower()
    explicit_bin = os.environ.get("BOOKSCANNER_CODEX_BIN", "").strip()

    if explicit_bin:
        if not agent_type:
            agent_type = "claude" if "claude" in Path(explicit_bin).name.lower() else "codex"
        return explicit_bin, agent_type

    # Try claude first if agent type is explicitly set
    if agent_type == "claude":
        claude_bin = shutil.which("claude") or ""
        if claude_bin:
            return claude_bin, "claude"
        return "", "claude"

    # Default: try codex, then claude as fallback
    codex_bin = shutil.which("codex") or ""
    if not codex_bin:
        app_bin = "/Applications/Codex.app/Contents/Resources/codex"
        if Path(app_bin).exists():
            codex_bin = app_bin
    if codex_bin:
        return codex_bin, agent_type or "codex"

    # Fallback to claude
    claude_bin = shutil.which("claude") or ""
    if claude_bin:
        return claude_bin, "claude"

    return "", agent_type or "codex"


def default_autofix_timeout_sec() -> int:
    profile = os.environ.get("BOOKSCANNER_AUTOMATION_PROFILE", "auto").strip().lower()
    if profile == "legacy":
        return 1200
    if profile == "codex":
        return 600
    return 600 if AUTOMATION_HOME == CODEX_HOME else 1200


def run_codex_fix(prompt: str) -> tuple[int, str]:
    timeout_sec = int(
        os.environ.get("BOOKSCANNER_AUTOFIX_TIMEOUT_SEC", str(default_autofix_timeout_sec()))
    )
    agent_bin, agent_type = resolve_agent_bin()

    if not agent_bin:
        return 1, "no agent binary found (set BOOKSCANNER_CODEX_BIN or BOOKSCANNER_AGENT_TYPE=claude)"

    if agent_type == "claude":
        cmd = [
            agent_bin,
            "-p",
            prompt,
            "--output-format",
            "text",
            "--dangerously-skip-permissions",
        ]
    else:
        cmd = [
            agent_bin,
            "exec",
            "--full-auto",
            "--cd",
            str(REPO_ROOT),
            "--output-last-message",
            str(LAST_MESSAGE_FILE),
            prompt,
        ]

    print(f"[auto-fix] agent={agent_type} running: {' '.join(cmd[:4])} ...")
    global ACTIVE_AGENT_PROCESS
    process = None
    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        ACTIVE_AGENT_PROCESS = process
        stdout, stderr = process.communicate(timeout=timeout_sec)
        output = (stdout or "") + (stderr or "")
        try:
            LAST_CODEX_OUTPUT_FILE.write_text(output[-20000:], encoding="utf-8")
        except Exception:
            pass
        # For claude, save stdout as the last message
        if agent_type == "claude" and stdout:
            try:
                LAST_MESSAGE_FILE.write_text(stdout.strip()[-4000:], encoding="utf-8")
            except Exception:
                pass
        return process.returncode, output
    except subprocess.TimeoutExpired as timeout_err:
        partial_output = (timeout_err.stdout or "") + (timeout_err.stderr or "")
        terminate_active_agent_process(force=True)
        try:
            timeout_summary = (
                f"{agent_type} exec timed out after {timeout_sec}s\n{partial_output[-4000:]}"
            )
            LAST_CODEX_OUTPUT_FILE.write_text(timeout_summary, encoding="utf-8")
        except Exception:
            pass
        return 124, f"{agent_type} exec timed out after {timeout_sec}s"
    except Exception as e:
        terminate_active_agent_process(force=True)
        try:
            LAST_CODEX_OUTPUT_FILE.write_text(f"{agent_type} exec failed: {e}", encoding="utf-8")
        except Exception:
            pass
        return 1, f"{agent_type} exec failed: {e}"
    finally:
        if ACTIVE_AGENT_PROCESS is process:
            ACTIVE_AGENT_PROCESS = None


def run_triage(rejects_file: Path, json_output: bool = False) -> int:
    if not rejects_file.exists():
        payload = {"ok": False, "error": f"rejects file not found: {rejects_file}"}
        if json_output:
            print(json.dumps(payload))
        else:
            print(f"[auto-fix] {payload['error']}")
        return 1

    payload = load_rejects(rejects_file)
    triage = triage_payload(payload)
    triage["sessionId"] = str(payload.get("sessionId", "unknown"))
    triage["file"] = str(rejects_file)
    triage["generatedAt"] = now_iso()

    if json_output:
        print(json.dumps(triage))
    else:
        print(f"[triage] session={triage['sessionId']}")
        print(f"[triage] rejects={triage['rejectCount']}")
        print(f"[triage] fixable={'yes' if triage['fixable'] else 'no'}")
        print(f"[triage] recommendation={triage['recommendation']}")

    return 0


def run_fix(rejects_file: Path) -> int:
    if not rejects_file.exists():
        print(f"[auto-fix] rejects file not found: {rejects_file}")
        return 1

    if not acquire_lock():
        return 0

    try:
        payload = load_rejects(rejects_file)
        reject_count = int(payload.get("rejectCount", len(payload.get("rejects", [])) or 0))
        session_id = str(payload.get("sessionId", "unknown"))
        if reject_count <= 0:
            print("[auto-fix] no rejects; nothing to do")
            return 0

        state = load_state()
        if should_debounce(payload, state):
            cooldown_sec = int(os.environ.get("BOOKSCANNER_AUTOFIX_COOLDOWN_SEC", "180"))
            print(
                f"[auto-fix] duplicate payload within cooldown ({cooldown_sec}s); skipping"
            )
            return 0

        dry_run = os.environ.get("BOOKSCANNER_AUTOFIX_DRY_RUN", "0") == "1"
        start_msg = (
            f"🛠️ *Codex Auto-Fix Started*\n"
            f"Session: `{session_id}`\n"
            f"Rejects: {reject_count}\n"
            f"File: `{rejects_file.name}`"
        )
        send_telegram(start_msg)

        allowed_files = parse_allowed_autofix_files()
        if allowed_files:
            allowed_display = ", ".join(sorted(allowed_files))
            print(f"[auto-fix] enforcing edit scope: {allowed_display}")

        prompt = build_prompt(rejects_file, payload, allowed_files)
        before_entries = parse_git_status_entries()
        before_changed = [entry["path"] for entry in before_entries]
        before_path_set = set(before_changed)
        preexisting_out_of_scope = sorted(
            {
                entry["path"]
                for entry in before_entries
                if entry["path"] not in allowed_files
            }
        )
        preexisting_out_of_scope_snapshots = (
            snapshot_paths(preexisting_out_of_scope) if allowed_files else {}
        )
        before_diff_fp = git_diff_fingerprint()

        if dry_run:
            print("[auto-fix] DRY RUN enabled; not invoking codex exec")
            exit_code = 0
            output = "dry-run"
        else:
            exit_code, output = run_codex_fix(prompt)
            if exit_code != 0:
                print(f"[auto-fix] codex exec failed with exit={exit_code}")
                if output:
                    print(f"[auto-fix] codex output tail: {output[-800:]}")

        after_entries = parse_git_status_entries()
        after_changed = [entry["path"] for entry in after_entries]
        unauthorized_paths: list[str] = []
        reverted_unauthorized: list[str] = []
        failed_unauthorized: list[str] = []
        touched_preexisting_out_of_scope: list[str] = []
        restored_preexisting_out_of_scope: list[str] = []
        failed_preexisting_out_of_scope: list[str] = []

        if allowed_files:
            unauthorized_paths = sorted(
                {
                    entry["path"]
                    for entry in after_entries
                    if entry["path"] not in before_path_set
                    and entry["path"] not in allowed_files
                }
            )
            if unauthorized_paths:
                print(
                    "[auto-fix] out-of-scope edits detected: "
                    + ", ".join(unauthorized_paths)
                )
                reverted_unauthorized, failed_unauthorized = revert_out_of_scope_paths(
                    unauthorized_paths
                )
                if reverted_unauthorized:
                    print(
                        "[auto-fix] reverted out-of-scope edits: "
                        + ", ".join(reverted_unauthorized)
                    )
                if failed_unauthorized:
                    print(
                        "[auto-fix] failed to revert out-of-scope edits: "
                        + ", ".join(failed_unauthorized)
                    )
                after_entries = parse_git_status_entries()
                after_changed = [entry["path"] for entry in after_entries]

            if preexisting_out_of_scope_snapshots:
                touched_preexisting_out_of_scope = sorted(
                    path
                    for path, snapshot in preexisting_out_of_scope_snapshots.items()
                    if snapshot_entry_changed(snapshot)
                )
                if touched_preexisting_out_of_scope:
                    print(
                        "[auto-fix] out-of-scope edits touched pre-existing dirty files: "
                        + ", ".join(touched_preexisting_out_of_scope)
                    )
                    (
                        restored_preexisting_out_of_scope,
                        failed_preexisting_out_of_scope,
                    ) = restore_paths_from_snapshots(
                        preexisting_out_of_scope_snapshots, touched_preexisting_out_of_scope
                    )
                    if restored_preexisting_out_of_scope:
                        print(
                            "[auto-fix] restored pre-existing out-of-scope files: "
                            + ", ".join(restored_preexisting_out_of_scope)
                        )
                    if failed_preexisting_out_of_scope:
                        print(
                            "[auto-fix] failed to restore pre-existing out-of-scope files: "
                            + ", ".join(failed_preexisting_out_of_scope)
                        )
                    after_entries = parse_git_status_entries()
                    after_changed = [entry["path"] for entry in after_entries]

        after_diff_fp = git_diff_fingerprint()
        new_changed = sorted(set(after_changed) - before_path_set)
        diff_changed = before_diff_fp != after_diff_fp
        if (failed_unauthorized or failed_preexisting_out_of_scope) and exit_code == 0:
            exit_code = 2
            output = (
                f"{output}\n[auto-fix] failed to fully enforce out-of-scope edits: "
                + ", ".join(sorted(set(failed_unauthorized + failed_preexisting_out_of_scope)))
            ).strip()

        summary_lines = [
            f"✅ *Codex Auto-Fix Finished* (exit={exit_code})",
            f"Session: `{session_id}`",
            f"Working tree files: {len(before_changed)} → {len(after_changed)}",
            f"Diff changed: {'yes' if diff_changed else 'no'}",
        ]
        if allowed_files:
            summary_lines.append(
                "Scope: " + ", ".join(f"`{path}`" for path in sorted(allowed_files))
            )
            if unauthorized_paths:
                summary_lines.append(
                    f"Out-of-scope detected: {len(unauthorized_paths)}"
                )
            if reverted_unauthorized:
                preview = ", ".join(f"`{path}`" for path in reverted_unauthorized[:6])
                summary_lines.append(f"Out-of-scope reverted: {preview}")
            if failed_unauthorized:
                preview = ", ".join(f"`{path}`" for path in failed_unauthorized[:6])
                summary_lines.append(f"Out-of-scope revert failed: {preview}")
            if touched_preexisting_out_of_scope:
                summary_lines.append(
                    f"Pre-existing out-of-scope touched: {len(touched_preexisting_out_of_scope)}"
                )
            if restored_preexisting_out_of_scope:
                preview = ", ".join(
                    f"`{path}`" for path in restored_preexisting_out_of_scope[:6]
                )
                summary_lines.append(f"Pre-existing out-of-scope restored: {preview}")
            if failed_preexisting_out_of_scope:
                preview = ", ".join(
                    f"`{path}`" for path in failed_preexisting_out_of_scope[:6]
                )
                summary_lines.append(
                    f"Pre-existing out-of-scope restore failed: {preview}"
                )
        if new_changed:
            preview = "\n".join([f"• `{p}`" for p in new_changed[:8]])
            summary_lines.append(preview)
            if len(new_changed) > 8:
                summary_lines.append(f"• ... and {len(new_changed) - 8} more")
        else:
            summary_lines.append("• no newly-added dirty files")

        if output:
            tail = output.strip()[-500:]
            if tail:
                summary_lines.append(f"\n`{tail}`")

        send_telegram("\n".join(summary_lines))

        state.update(
            {
                "lastRunAt": now_iso(),
                "lastRunEpochSec": time.time(),
                "lastSessionId": session_id,
                "lastRejectCount": reject_count,
                "lastRejectsFile": str(rejects_file),
                "lastFingerprint": fingerprint_rejects(payload),
                "lastExitCode": exit_code,
                "lastWorkingTreeCountBefore": len(before_changed),
                "lastWorkingTreeCountAfter": len(after_changed),
                "lastDiffChanged": diff_changed,
                "lastNewDirtyFilesCount": len(new_changed),
                "lastAllowedFiles": sorted(allowed_files),
                "lastOutOfScopeDetectedCount": len(unauthorized_paths),
                "lastOutOfScopeRevertedCount": len(reverted_unauthorized),
                "lastOutOfScopeFailedCount": len(failed_unauthorized),
                "lastPreexistingOutOfScopeTouchedCount": len(
                    touched_preexisting_out_of_scope
                ),
                "lastPreexistingOutOfScopeRestoredCount": len(
                    restored_preexisting_out_of_scope
                ),
                "lastPreexistingOutOfScopeFailedCount": len(
                    failed_preexisting_out_of_scope
                ),
                "debounceDisabled": os.environ.get(
                    "BOOKSCANNER_AUTOFIX_DISABLE_DEBOUNCE", "0"
                )
                == "1",
            }
        )
        save_state(state)
        return 0 if exit_code == 0 else 1
    finally:
        release_lock()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="BookScanner Codex auto-fix utility (triage + fix)"
    )
    parser.add_argument("rejects_file", help="Path to rejects JSON file")
    parser.add_argument(
        "--triage",
        action="store_true",
        help="Run triage only and print a summary",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="When used with --triage, print machine-readable JSON",
    )
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])
    rejects_file = Path(args.rejects_file).expanduser().resolve()
    if args.triage:
        return run_triage(rejects_file, json_output=args.json)
    return run_fix(rejects_file)


if __name__ == "__main__":
    sys.exit(main())
