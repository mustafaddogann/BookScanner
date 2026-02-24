#!/usr/bin/env node
/**
 * Auto-Fix Daemon
 *
 * Watches for new rejects and delegates to auto-fix.py (which calls codex/claude).
 * Deduplicates by session+rejectCount so the same payload doesn't trigger
 * multiple fix cycles. Stops retrying after MAX_ATTEMPTS_PER_SESSION.
 *
 * Usage: node scripts/autoFixDaemon.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Profile-aware paths
const AUTOMATION_PROFILE = (process.env.BOOKSCANNER_AUTOMATION_PROFILE || 'codex').toLowerCase();
const AUTOMATION_HOME = process.env.BOOKSCANNER_AUTOMATION_HOME ||
  path.join(os.homedir(), AUTOMATION_PROFILE === 'legacy'
    ? '.claude/clawdbot-instructions'
    : '.claude/codex-bookscanner-loop');

const DOCUMENTS_DIR = path.join(AUTOMATION_HOME, 'documents');
const STATE_FILE = path.join(__dirname, '.autofix_daemon_state.json');

const CHECK_INTERVAL_MS = 15000; // Check every 15 seconds (was 5 — too fast)
const MAX_ATTEMPTS_PER_SESSION = 3; // Stop after 3 fix attempts for same session+rejects
const COOLDOWN_AFTER_FIX_MS = 120000; // Wait 2 min after spawning auto-fix before checking again

// State tracks which sessions we've already processed
let state = {
  processedHashes: {}, // hash -> { count, lastTime, sessionId, rejectCount }
  lastSpawnTime: 0,
};

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch { /* start fresh */ }
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function hashPayload(data) {
  const rejects = (data.rejects || []).map(r => `${r.id || ''}|${r.resolverDecisionReason || ''}|${(r.mergedText || '').substring(0, 100)}`);
  rejects.sort();
  return crypto.createHash('sha1').update(rejects.join('\n')).digest('hex').substring(0, 12);
}

function findLatestRejectsFile() {
  if (!fs.existsSync(DOCUMENTS_DIR)) return null;

  const files = fs.readdirSync(DOCUMENTS_DIR)
    .filter(f => f.startsWith('rejects_') && f.endsWith('.json'))
    .map(f => {
      const fullPath = path.join(DOCUMENTS_DIR, f);
      return {
        name: f,
        path: fullPath,
        mtime: fs.statSync(fullPath).mtime.getTime(),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return files[0] || null;
}

function spawnAutoFix(filepath) {
  const autoFixScript = path.join(__dirname, 'auto-fix.py');
  if (!fs.existsSync(autoFixScript)) {
    console.log('[daemon] auto-fix.py not found, skipping');
    return;
  }

  // Ensure ~/.local/bin is in PATH
  const localBin = path.join(os.homedir(), '.local/bin');
  const envPath = process.env.PATH || '';
  const childEnv = {
    ...process.env,
    PATH: envPath.includes(localBin) ? envPath : `${localBin}:${envPath}`,
    BOOKSCANNER_AUTOMATION_PROFILE: AUTOMATION_PROFILE,
    BOOKSCANNER_AUTOMATION_HOME: AUTOMATION_HOME,
  };

  const { spawn } = require('child_process');
  const proc = spawn('python3', [autoFixScript, filepath], {
    detached: true,
    stdio: 'ignore',
    env: childEnv,
  });
  proc.unref();
  console.log(`[daemon] auto-fix.py spawned for ${path.basename(filepath)}`);
}

function checkForNewRejects() {
  // Don't check if we recently spawned a fix (give codex time to work)
  const timeSinceLastSpawn = Date.now() - (state.lastSpawnTime || 0);
  if (timeSinceLastSpawn < COOLDOWN_AFTER_FIX_MS) {
    return; // silently wait
  }

  const latestFile = findLatestRejectsFile();
  if (!latestFile) return;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(latestFile.path, 'utf8'));
  } catch {
    return;
  }

  const rejectCount = data.rejectCount || (data.rejects || []).length || 0;
  if (rejectCount === 0) return;

  const hash = hashPayload(data);
  const sessionId = data.sessionId || 'unknown';
  const existing = state.processedHashes[hash];

  if (existing) {
    if (existing.count >= MAX_ATTEMPTS_PER_SESSION) {
      // Already tried enough times — don't spam
      return;
    }
  }

  // New or retry-worthy payload — process it
  console.log(`\n[daemon] New rejects: ${rejectCount} from session ${sessionId} (hash=${hash}, attempt=${(existing?.count || 0) + 1}/${MAX_ATTEMPTS_PER_SESSION})`);

  state.processedHashes[hash] = {
    count: (existing?.count || 0) + 1,
    lastTime: new Date().toISOString(),
    sessionId,
    rejectCount,
    file: latestFile.name,
  };
  state.lastSpawnTime = Date.now();
  saveState();

  // Spawn auto-fix.py (which handles codex/claude invocation, rebuild, rescan)
  spawnAutoFix(latestFile.path);
}

function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            BookScanner Auto-Fix Daemon                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Profile:    ${AUTOMATION_PROFILE}`);
  console.log(`Documents:  ${DOCUMENTS_DIR}`);
  console.log(`Max tries:  ${MAX_ATTEMPTS_PER_SESSION} per unique payload`);
  console.log(`Cooldown:   ${COOLDOWN_AFTER_FIX_MS / 1000}s after each fix`);
  console.log('');
  console.log('Press Ctrl+C to stop\n');

  loadState();

  // Initial check
  checkForNewRejects();

  // Start watching
  setInterval(checkForNewRejects, CHECK_INTERVAL_MS);
}

main();
