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


def git_changed_files() -> list[str]:
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=20,
        )
        files: list[str] = []
        for raw in result.stdout.splitlines():
            line = raw.strip()
            if len(line) < 4:
                continue
            files.append(line[3:])
        return files
    except Exception:
        return []


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


def build_prompt(rejects_file: Path, payload: dict[str, Any]) -> str:
    session_id = payload.get("sessionId", "unknown")
    reject_count = payload.get("rejectCount", len(payload.get("rejects", [])) or 0)
    total_books = payload.get("totalBooks", "?")
    return f"""You are fixing BookScanner metadata resolution quality.

Rejects JSON: {rejects_file}
Rejected: {reject_count}/{total_books}

Steps:
1. Read the rejects JSON. There are {reject_count} rejected books.
2. For each reject, look at mergedText and resolverDecisionReason.
3. Apply minimal, generic fixes to the codebase - focus on src/services/queryHypotheses.ts and src/services/candidateScoring.ts
4. Do NOT commit. Do NOT run tests.
5. Return a short summary of what you changed.

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


def run_codex_fix(prompt: str) -> tuple[int, str]:
    timeout_sec = int(os.environ.get("BOOKSCANNER_AUTOFIX_TIMEOUT_SEC", "1200"))
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
    try:
        result = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        output = (result.stdout or "") + (result.stderr or "")
        try:
            LAST_CODEX_OUTPUT_FILE.write_text(output[-20000:], encoding="utf-8")
        except Exception:
            pass
        # For claude, save stdout as the last message
        if agent_type == "claude" and result.stdout:
            try:
                LAST_MESSAGE_FILE.write_text(result.stdout.strip()[-4000:], encoding="utf-8")
            except Exception:
                pass
        return result.returncode, output
    except subprocess.TimeoutExpired:
        try:
            LAST_CODEX_OUTPUT_FILE.write_text(f"{agent_type} exec timed out", encoding="utf-8")
        except Exception:
            pass
        return 124, f"{agent_type} exec timed out"
    except Exception as e:
        try:
            LAST_CODEX_OUTPUT_FILE.write_text(f"{agent_type} exec failed: {e}", encoding="utf-8")
        except Exception:
            pass
        return 1, f"{agent_type} exec failed: {e}"


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

        prompt = build_prompt(rejects_file, payload)
        before_changed = git_changed_files()
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

        after_changed = git_changed_files()
        after_diff_fp = git_diff_fingerprint()
        new_changed = sorted(set(after_changed) - set(before_changed))
        diff_changed = before_diff_fp != after_diff_fp
        summary_lines = [
            f"✅ *Codex Auto-Fix Finished* (exit={exit_code})",
            f"Session: `{session_id}`",
            f"Working tree files: {len(before_changed)} → {len(after_changed)}",
            f"Diff changed: {'yes' if diff_changed else 'no'}",
        ]
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
