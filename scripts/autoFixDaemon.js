#!/usr/bin/env node
/**
 * Codex/Claude auto-fix watcher daemon.
 *
 * Architecture:
 * 1) Poll instructions.md for ACTION: FIX_REQUEST blocks
 * 2) Run triage on each request's rejects JSON
 * 3) If fixable, run AI fix
 * 4) Optionally rebuild and/or signal rescan
 *
 * Usage: node scripts/autoFixDaemon.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync, execSync, spawn } = require('child_process');
const {
  automationHome,
  documentsDir,
  instructionsFile,
  telegramSendScript,
  autoFixScript,
  getAgentName,
  ensureAutomationDirs,
} = require('./automationConfig');

const AGENT_NAME = getAgentName();
const REPO_ROOT = path.resolve(__dirname, '..');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');
const SIGNAL_RESCAN_SCRIPT = path.join(__dirname, 'signalRescan.js');
const STATE_FILE = path.join(automationHome, '.fix_watcher_state.json');

const CHECK_INTERVAL_MS = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_POLL_MS || '15000',
  10
);
const REQUEST_DEDUPE_COOLDOWN_SEC = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_REQUEST_COOLDOWN_SEC || '180',
  10
);
const FIX_TIMEOUT_MS = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_DAEMON_FIX_TIMEOUT_MS || '1300000',
  10
);
const TRIAGE_TIMEOUT_MS = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_DAEMON_TRIAGE_TIMEOUT_MS || '90000',
  10
);
const AUTO_REBUILD_CMD = (process.env.BOOKSCANNER_AUTOFIX_REBUILD_CMD || '').trim();
const AUTO_SIGNAL_RESCAN = process.env.BOOKSCANNER_AUTOFIX_SIGNAL_RESCAN === '1';
const AUTO_RESCAN_REASON =
  process.env.BOOKSCANNER_AUTOFIX_RESCAN_REASON || 'New fixes deployed. Please rescan.';
const FORCE_FIX =
  process.env.BOOKSCANNER_AUTOFIX_FORCE_FIX === '1' ||
  (AGENT_NAME === 'Codex' && process.env.BOOKSCANNER_AUTOFIX_FORCE_FIX !== '0');
const DISABLE_FINGERPRINT_DEDUPE =
  process.env.BOOKSCANNER_AUTOFIX_DISABLE_FINGERPRINT_DEDUPE === '1' ||
  (AGENT_NAME === 'Codex' &&
    process.env.BOOKSCANNER_AUTOFIX_DISABLE_FINGERPRINT_DEDUPE !== '0');
const PROCESS_EXISTING_ON_START =
  process.env.BOOKSCANNER_AUTOFIX_PROCESS_EXISTING_ON_START === '1' ||
  (AGENT_NAME !== 'Codex' &&
    process.env.BOOKSCANNER_AUTOFIX_PROCESS_EXISTING_ON_START !== '0');
const LATEST_PER_SESSION = process.env.BOOKSCANNER_AUTOFIX_LATEST_PER_SESSION !== '0';
const MAX_PENDING_CONSIDER = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_MAX_PENDING || '80',
  10
);
const TELEGRAM_TIMEOUT_MS = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_TELEGRAM_TIMEOUT_MS || '15000',
  10
);
const ACTIVE_REQUEST_STALE_MS = Number.parseInt(
  process.env.BOOKSCANNER_AUTOFIX_ACTIVE_STALE_MS || `${FIX_TIMEOUT_MS + 120000}`,
  10
);
let startupSequenceCutoff = -1;

function logBanner() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            BookScanner Auto-Fix Daemon                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Automation Home: ${automationHome}`);
  console.log(`Agent: ${AGENT_NAME}`);
  console.log('');
  console.log('Watching FIX_REQUEST entries and fixing automatically...');
  console.log(`Instructions: ${instructionsFile}`);
  console.log(`Documents: ${documentsDir}`);
  console.log('');
  console.log(`Poll interval: ${CHECK_INTERVAL_MS}ms`);
  console.log(`Newest-first queue: ${LATEST_PER_SESSION ? 'enabled' : 'disabled'}`);
  console.log(`Fix timeout: ${FIX_TIMEOUT_MS}ms`);
  console.log(`Force fix when triage says skip: ${FORCE_FIX ? 'enabled' : 'disabled'}`);
  console.log(
    `Fingerprint dedupe: ${DISABLE_FINGERPRINT_DEDUPE ? 'disabled' : `enabled (${REQUEST_DEDUPE_COOLDOWN_SEC}s)`}`
  );
  console.log(
    `Process existing FIX_REQUEST entries on startup: ${PROCESS_EXISTING_ON_START ? 'yes' : 'no (new requests only)'}`
  );
  if (AUTO_REBUILD_CMD) {
    console.log(`Auto rebuild: enabled (${AUTO_REBUILD_CMD})`);
  } else {
    console.log('Auto rebuild: disabled');
  }
  console.log(`Auto rescan signal: ${AUTO_SIGNAL_RESCAN ? 'enabled' : 'disabled'}`);
  console.log('');
  console.log('Press Ctrl+C to stop\n');
}

function sendTelegram(message) {
  if (!fs.existsSync(telegramSendScript)) {
    return false;
  }

  try {
    const proc = spawn('python3', [telegramSendScript], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    proc.stdin.write(message, 'utf8');
    proc.stdin.end();

    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_err) {
        // ignore
      }
    }, TELEGRAM_TIMEOUT_MS);

    proc.on('exit', () => clearTimeout(killTimer));
    proc.unref();
    return true;
  } catch (err) {
    console.error('[daemon] Telegram send failed:', err.message);
    return false;
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      fixCycle: 0,
      processedRequestIds: [],
      processedRequests: {},
      recentFingerprints: {},
      lastProcessedAt: null,
      activeRequest: null,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      fixCycle: Number.isFinite(parsed.fixCycle) ? parsed.fixCycle : 0,
      processedRequestIds: Array.isArray(parsed.processedRequestIds)
        ? parsed.processedRequestIds
        : [],
      processedRequests: parsed.processedRequests && typeof parsed.processedRequests === 'object'
        ? parsed.processedRequests
        : {},
      recentFingerprints: parsed.recentFingerprints && typeof parsed.recentFingerprints === 'object'
        ? parsed.recentFingerprints
        : {},
      lastProcessedAt: parsed.lastProcessedAt || null,
      activeRequest: parsed.activeRequest || null,
    };
  } catch (err) {
    console.error('[daemon] Failed to load state file, starting fresh:', err.message);
    return {
      fixCycle: 0,
      processedRequestIds: [],
      processedRequests: {},
      recentFingerprints: {},
      lastProcessedAt: null,
      activeRequest: null,
    };
  }
}

function saveState(state) {
  const cappedRequestIds = state.processedRequestIds.slice(-1000);
  const nowMs = Date.now();
  const maxAgeMs = REQUEST_DEDUPE_COOLDOWN_SEC * 1000 * 8;
  const compactFingerprints = {};
  for (const [fingerprint, ts] of Object.entries(state.recentFingerprints || {})) {
    const age = nowMs - new Date(ts).getTime();
    if (Number.isFinite(age) && age < maxAgeMs) {
      compactFingerprints[fingerprint] = ts;
    }
  }
  state.processedRequestIds = cappedRequestIds;
  state.recentFingerprints = compactFingerprints;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function parseFixRequestsFromInstructions(content) {
  const blocks = content.split(/^---$/m).map((block) => block.trim()).filter(Boolean);
  const requests = [];
  let sequence = 0;

  for (const block of blocks) {
    if (!/ACTION:\s*FIX_REQUEST/i.test(block)) {
      continue;
    }

    const timestampMatch = block.match(/\*\*\[([^\]]+)\]\*\*/);
    const requestIdMatch =
      block.match(/\*\*Request ID:\*\*\s*([^\n]+)/i) || block.match(/Request ID:\s*([^\n]+)/i);
    const fileMatch =
      block.match(/\*\*Rejects File:\*\*\s*([^\n]+)/i) || block.match(/Rejects File:\s*([^\n]+)/i);
    const sessionMatch = block.match(/session\s+([A-Za-z0-9_-]+)/i);

    const timestamp = timestampMatch ? timestampMatch[1].trim() : null;
    const rejectsFile = fileMatch ? fileMatch[1].trim() : null;
    const requestId =
      requestIdMatch?.[1]?.trim() ||
      crypto.createHash('sha1').update(block).digest('hex').slice(0, 16);

    if (!rejectsFile) {
      continue;
    }

    requests.push({
      requestId,
      timestamp,
      rejectsFile,
      sessionId: sessionMatch ? sessionMatch[1] : 'unknown',
      sequence,
    });
    sequence += 1;
  }

  return requests;
}

function getFixRequests() {
  if (!fs.existsSync(instructionsFile)) {
    return [];
  }
  const content = fs.readFileSync(instructionsFile, 'utf8');
  return parseFixRequestsFromInstructions(content);
}

function resolveRejectsPath(candidatePath) {
  const trimmed = String(candidatePath || '').trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }

  const inDocuments = path.join(documentsDir, trimmed);
  if (fs.existsSync(inDocuments)) {
    return inDocuments;
  }

  const relativeToHome = path.join(automationHome, trimmed);
  if (fs.existsSync(relativeToHome)) {
    return relativeToHome;
  }

  return inDocuments;
}

function computeRejectFingerprint(filepath) {
  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    const rejects = Array.isArray(data.rejects) ? data.rejects : [];
    const rows = rejects
      .map((item) => {
        const id = String(item.id || '');
        const reason = String(item.resolverDecisionReason || '');
        const text = String(item.mergedText || '').slice(0, 160);
        return `${id}|${reason}|${text}`;
      })
      .sort()
      .join('\n');
    return crypto.createHash('sha1').update(rows).digest('hex');
  } catch (err) {
    try {
      const stats = fs.statSync(filepath);
      return crypto
        .createHash('sha1')
        .update(`${filepath}|${stats.size}|${stats.mtimeMs}`)
        .digest('hex');
    } catch (_err) {
      return '';
    }
  }
}

function isFingerprintDuplicate(state, fingerprint) {
  if (DISABLE_FINGERPRINT_DEDUPE) return false;
  if (!fingerprint) return false;
  const ts = state.recentFingerprints[fingerprint];
  if (!ts) return false;
  const elapsedMs = Date.now() - new Date(ts).getTime();
  return elapsedMs < REQUEST_DEDUPE_COOLDOWN_SEC * 1000;
}

function markRequestProcessed(state, request, status, details) {
  const processedAt = new Date().toISOString();
  state.processedRequestIds.push(request.requestId);
  state.processedRequests[request.requestId] = {
    processedAt,
    sessionId: request.sessionId,
    rejectsFile: request.rejectsFile,
    status,
    ...(details || {}),
  };
  state.lastProcessedAt = processedAt;
}

function runAnalysis(filepath) {
  try {
    const output = execSync(`node "${ANALYZE_SCRIPT}" "${filepath}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return output;
  } catch (err) {
    return `Error analyzing file: ${err.message}`;
  }
}

function workingTreeFingerprint() {
  try {
    const result = execSync('git status --porcelain', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return crypto.createHash('sha1').update(result).digest('hex');
  } catch (_err) {
    return null;
  }
}

function parseTriageOutput(stdout, stderr, status) {
  const blob = `${stdout || ''}\n${stderr || ''}`.trim();
  const lines = blob.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      return parsed;
    } catch (_err) {
      // continue
    }
  }

  return {
    ok: false,
    fixable: false,
    recommendation: 'triage_parse_failed',
    status,
    raw: blob.slice(-1200),
  };
}

function runTriage(filepath) {
  if (!fs.existsSync(autoFixScript)) {
    return {
      ok: false,
      fixable: false,
      recommendation: 'missing_auto_fix_script',
      error: `Missing script: ${autoFixScript}`,
    };
  }

  const result = spawnSync('python3', [autoFixScript, '--triage', '--json', filepath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: TRIAGE_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
    env: {
      ...process.env,
      BOOKSCANNER_AUTOMATION_HOME: automationHome,
      BOOKSCANNER_PROJECT_DIR: REPO_ROOT,
    },
  });

  if (result.error) {
    return {
      ok: false,
      fixable: false,
      recommendation: 'triage_failed',
      error: result.error.message,
    };
  }

  return parseTriageOutput(result.stdout, result.stderr, result.status);
}

function runFix(filepath) {
  if (!fs.existsSync(autoFixScript)) {
    return {
      ok: false,
      exitCode: 1,
      error: `Missing script: ${autoFixScript}`,
      outputTail: '',
    };
  }

  const result = spawnSync('python3', [autoFixScript, filepath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: FIX_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      BOOKSCANNER_AUTOMATION_HOME: automationHome,
      BOOKSCANNER_PROJECT_DIR: REPO_ROOT,
      BOOKSCANNER_AUTOFIX_DISABLE_DEBOUNCE: '1',
    },
  });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const outputTail = output.slice(-1500);
  const skippedByLock = /lock active pid=/i.test(output);
  const skippedByDebounce = /duplicate payload within cooldown/i.test(output);
  const skippedNoRejects = /no rejects; nothing to do/i.test(output);
  const skipped = skippedByLock || skippedByDebounce || skippedNoRejects;
  if (result.error) {
    return {
      ok: false,
      skipped,
      exitCode: 1,
      error: result.error.message,
      outputTail,
    };
  }

  return {
    ok: result.status === 0 && !skipped,
    skipped,
    exitCode: Number.isFinite(result.status) ? result.status : 1,
    error: result.status === 0 ? null : `fix exited with code ${result.status}`,
    outputTail,
  };
}

function runRebuildAndRescanIfEnabled() {
  const outcome = {
    rebuildAttempted: false,
    rebuildSucceeded: false,
    rebuildError: null,
    rescanSignaled: false,
    rescanError: null,
  };

  if (!AUTO_REBUILD_CMD && !AUTO_SIGNAL_RESCAN) {
    return outcome;
  }

  if (AUTO_REBUILD_CMD) {
    outcome.rebuildAttempted = true;
    console.log(`[daemon] running rebuild command: ${AUTO_REBUILD_CMD}`);
    try {
      execSync(AUTO_REBUILD_CMD, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: FIX_TIMEOUT_MS,
      });
      outcome.rebuildSucceeded = true;
      console.log('[daemon] rebuild completed');
    } catch (err) {
      outcome.rebuildError = err.message || String(err);
      console.error(`[daemon] rebuild failed: ${outcome.rebuildError}`);
      return outcome;
    }
  }

  if (AUTO_SIGNAL_RESCAN) {
    console.log('[daemon] writing rescan signal...');
    try {
      const args = [SIGNAL_RESCAN_SCRIPT, '--reason', AUTO_RESCAN_REASON];
      execFileSync(process.execPath, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30000,
      });
      outcome.rescanSignaled = true;
      console.log('[daemon] rescan signal written');
    } catch (err) {
      outcome.rescanError = err.message || String(err);
      console.error(`[daemon] rescan signal failed: ${outcome.rescanError}`);
    }
  }

  return outcome;
}

function getPendingFixRequests(state) {
  const allRequests = getFixRequests();
  const latestSequenceBySession = new Map();
  for (const req of allRequests) {
    const sessionKey = req.sessionId || req.rejectsFile;
    const prev = latestSequenceBySession.get(sessionKey);
    if (prev == null || req.sequence > prev) {
      latestSequenceBySession.set(sessionKey, req.sequence);
    }
  }

  let pending = allRequests.filter((req) => !state.processedRequestIds.includes(req.requestId));
  if (!PROCESS_EXISTING_ON_START && startupSequenceCutoff >= 0) {
    pending = pending.filter((req) => req.sequence > startupSequenceCutoff);
  }
  if (LATEST_PER_SESSION) {
    pending = pending.filter((req) => {
      const sessionKey = req.sessionId || req.rejectsFile;
      const latestSeq = latestSequenceBySession.get(sessionKey);
      return latestSeq == null || req.sequence === latestSeq;
    });
  }

  pending.sort((a, b) => b.sequence - a.sequence);

  let selected = pending;
  if (LATEST_PER_SESSION) {
    const seenSessions = new Set();
    selected = [];
    for (const req of pending) {
      const sessionKey = req.sessionId || req.rejectsFile;
      if (seenSessions.has(sessionKey)) {
        continue;
      }
      seenSessions.add(sessionKey);
      selected.push(req);
    }
  }

  if (Number.isFinite(MAX_PENDING_CONSIDER) && MAX_PENDING_CONSIDER > 0) {
    selected = selected.slice(0, MAX_PENDING_CONSIDER);
  }

  return selected;
}

function initializeStartupSequenceCutoff() {
  if (PROCESS_EXISTING_ON_START) {
    startupSequenceCutoff = -1;
    return;
  }

  const existing = getFixRequests();
  startupSequenceCutoff = existing.reduce(
    (max, req) => (req.sequence > max ? req.sequence : max),
    -1
  );
  console.log(
    `[daemon] startup cutoff set to sequence=${startupSequenceCutoff}; existing FIX_REQUEST entries will be ignored`
  );
}

function maybeClearStaleActiveRequest(state) {
  if (!state.activeRequest) {
    return false;
  }

  const startedAtMs = new Date(state.activeRequest.startedAt || 0).getTime();
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    console.warn('[daemon] clearing malformed activeRequest state');
    state.activeRequest = null;
    saveState(state);
    return true;
  }

  const ageMs = Date.now() - startedAtMs;
  if (ageMs <= ACTIVE_REQUEST_STALE_MS) {
    return false;
  }

  console.warn(
    `[daemon] clearing stale activeRequest requestId=${state.activeRequest.requestId} ageMs=${ageMs}`
  );
  state.activeRequest = null;
  saveState(state);
  return true;
}

function processRequest(request, state) {
  const resolvedRejectsPath = resolveRejectsPath(request.rejectsFile);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROCESSING FIX_REQUEST: ${request.requestId}`);
  console.log(`Cycle: ${state.fixCycle + 1}`);
  console.log(`Rejects file: ${resolvedRejectsPath}`);
  console.log(`${'='.repeat(60)}`);

  if (!resolvedRejectsPath || !fs.existsSync(resolvedRejectsPath)) {
    const error = `Rejects file not found: ${request.rejectsFile}`;
    console.error(`[daemon] ${error}`);
    markRequestProcessed(state, request, 'missing_file', { error });
    sendTelegram(`⚠️ *Auto-Fix Skipped*\nRequest: \`${request.requestId}\`\n${error}`);
    saveState(state);
    return;
  }

  const fingerprint = computeRejectFingerprint(resolvedRejectsPath);
  if (isFingerprintDuplicate(state, fingerprint)) {
    console.log('[daemon] duplicate rejects fingerprint within cooldown; skipping');
    markRequestProcessed(state, request, 'duplicate_skipped', {
      fingerprint,
      cooldownSec: REQUEST_DEDUPE_COOLDOWN_SEC,
    });
    saveState(state);
    return;
  }

  const analysisOutput = runAnalysis(resolvedRejectsPath);
  console.log(analysisOutput);

  const triage = runTriage(resolvedRejectsPath);
  console.log('[daemon] triage:', JSON.stringify(triage));

  const triageAllowsFix = triage.ok && triage.fixable;
  if (!triageAllowsFix && !FORCE_FIX) {
    if (!triage.ok) {
      markRequestProcessed(state, request, 'triage_failed', {
        fingerprint,
        triage,
      });
      state.recentFingerprints[fingerprint] = new Date().toISOString();
      saveState(state);
      sendTelegram(
        `⚠️ *Auto-Fix Triage Failed*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nReason: ${triage.recommendation || triage.error || 'unknown'}`
      );
      return;
    }

    markRequestProcessed(state, request, 'triage_not_fixable', {
      fingerprint,
      triage,
    });
    state.recentFingerprints[fingerprint] = new Date().toISOString();
    saveState(state);
    sendTelegram(
      `ℹ️ *Auto-Fix Skipped (triage)*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nRecommendation: ${triage.recommendation || 'manual_investigation'}`
    );
    return;
  }

  if (!triage.ok && FORCE_FIX) {
    console.warn('[daemon] triage failed; forcing fix attempt');
    sendTelegram(
      `⚠️ *${AGENT_NAME} Auto-Fix Force Mode*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nTriage failed, continuing with fix attempt.`
    );
  } else if (!triage.fixable && FORCE_FIX) {
    console.warn(
      `[daemon] triage recommended skip (${triage.recommendation || 'unknown'}); forcing fix attempt`
    );
    sendTelegram(
      `ℹ️ *${AGENT_NAME} Auto-Fix Force Mode*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nTriage said "${triage.recommendation || 'skip'}", continuing with fix attempt.`
    );
  }

  sendTelegram(
    `🛠️ *${AGENT_NAME} Auto-Fix Started*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nRejects: ${triage.rejectCount || '?'}`
  );

  state.activeRequest = {
    requestId: request.requestId,
    sessionId: request.sessionId,
    rejectsFile: request.rejectsFile,
    startedAt: new Date().toISOString(),
  };
  saveState(state);
  console.log('[daemon] running AI fix...');
  const beforeFingerprint = workingTreeFingerprint();
  const fixResult = runFix(resolvedRejectsPath);
  const afterFingerprint = workingTreeFingerprint();
  const diffChanged =
    beforeFingerprint !== null &&
    afterFingerprint !== null &&
    beforeFingerprint !== afterFingerprint;
  state.activeRequest = null;
  state.recentFingerprints[fingerprint] = new Date().toISOString();
  console.log(
    `[daemon] AI fix result: ok=${fixResult.ok} skipped=${Boolean(
      fixResult.skipped
    )} exit=${fixResult.exitCode} error=${fixResult.error || 'none'}`
  );

  if (fixResult.skipped) {
    markRequestProcessed(state, request, 'fix_skipped', {
      fingerprint,
      triage,
      fixResult: {
        exitCode: fixResult.exitCode,
        error: fixResult.error,
        outputTail: fixResult.outputTail,
        diffChanged,
      },
    });
    saveState(state);
    sendTelegram(
      `ℹ️ *${AGENT_NAME} Auto-Fix Skipped*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nReason: lock/debounce/no-op`
    );
    return;
  }

  state.fixCycle += 1;
  if (!fixResult.ok) {
    markRequestProcessed(state, request, 'fix_failed', {
      fingerprint,
      triage: triage
        ? {
            ...triage,
            forcedFixAttempt: FORCE_FIX,
          }
        : triage,
      fixResult: {
        exitCode: fixResult.exitCode,
        error: fixResult.error,
        outputTail: fixResult.outputTail,
        diffChanged,
      },
    });
    saveState(state);
    sendTelegram(
      `❌ *${AGENT_NAME} Auto-Fix Failed*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nExit: ${fixResult.exitCode}\nError: ${fixResult.error || 'unknown'}`
    );
    return;
  }

  if (!diffChanged) {
    markRequestProcessed(state, request, 'fix_no_change', {
      fingerprint,
      triage,
      fixResult: {
        exitCode: fixResult.exitCode,
        outputTail: fixResult.outputTail,
        diffChanged,
      },
    });
    saveState(state);
    sendTelegram(
      `ℹ️ *${AGENT_NAME} Auto-Fix No Changes*\nRequest: \`${request.requestId}\`\nSession: \`${request.sessionId}\`\nNo code diff produced; rebuild/rescan skipped.`
    );
    return;
  }

  const rebuild = runRebuildAndRescanIfEnabled();
  markRequestProcessed(state, request, 'fix_applied', {
    fingerprint,
    triage,
    fixResult: {
      exitCode: fixResult.exitCode,
      outputTail: fixResult.outputTail,
      diffChanged,
    },
    rebuild,
  });
  saveState(state);

  const lines = [
    `✅ *${AGENT_NAME} Auto-Fix Applied*`,
    `Request: \`${request.requestId}\``,
    `Session: \`${request.sessionId}\``,
    `Exit: ${fixResult.exitCode}`,
  ];
  if (rebuild.rebuildAttempted) {
    lines.push(
      `Rebuild: ${rebuild.rebuildSucceeded ? 'ok' : `failed (${rebuild.rebuildError || 'error'})`}`
    );
  }
  if (AUTO_SIGNAL_RESCAN) {
    lines.push(`Rescan signal: ${rebuild.rescanSignaled ? 'sent' : `failed (${rebuild.rescanError || 'error'})`}`);
  }
  sendTelegram(lines.join('\n'));
}

function tick(state) {
  maybeClearStaleActiveRequest(state);

  const pending = getPendingFixRequests(state);
  if (pending.length === 0) {
    return;
  }

  if (pending.length > 1) {
    console.log(
      `[daemon] pending FIX_REQUEST count=${pending.length}; processing newest first`
    );
  }

  processRequest(pending[0], state);
}

function main() {
  ensureAutomationDirs();
  logBanner();

  const state = loadState();
  initializeStartupSequenceCutoff();
  maybeClearStaleActiveRequest(state);
  tick(state);
  setInterval(() => tick(state), CHECK_INTERVAL_MS);
}

main();
