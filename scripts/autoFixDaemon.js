#!/usr/bin/env node
/**
 * Auto-Fix Daemon
 *
 * Fully automated reject fixing loop:
 * 1. Watches for new rejects from the app
 * 2. Analyzes issues
 * 3. Writes fix instructions for Claude Code
 * 4. Triggers rebuild after fixes
 * 5. Notifies via Telegram
 *
 * Usage: node scripts/autoFixDaemon.js
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');

// Configuration
const DOCUMENTS_DIR = path.join(os.homedir(), '.claude/clawdbot-instructions/documents');
const INSTRUCTIONS_FILE = path.join(os.homedir(), '.claude/clawdbot-instructions/instructions.md');
const TELEGRAM_SEND = path.join(os.homedir(), '.claude/clawdbot-instructions/telegram-bot/send.py');
const STATE_FILE = path.join(__dirname, '.autofix_state.json');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');

const CHECK_INTERVAL_MS = 5000; // Check every 5 seconds

// State
let state = {
  lastProcessedFile: null,
  lastProcessedTime: null,
  fixCycle: 0,
  totalRejectsFixed: 0,
};

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sendTelegram(message) {
  try {
    execSync(`python3 "${TELEGRAM_SEND}" "${message.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    return false;
  }
}

function findLatestRejectsFile() {
  if (!fs.existsSync(DOCUMENTS_DIR)) return null;

  const files = fs.readdirSync(DOCUMENTS_DIR)
    .filter(f => f.startsWith('rejects_') && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(DOCUMENTS_DIR, f),
      mtime: fs.statSync(path.join(DOCUMENTS_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0] || null;
}

function analyzeRejectsFile(filepath) {
  const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  const analysis = {
    sessionId: data.sessionId,
    totalBooks: data.totalBooks || 0,
    rejectCount: data.rejectCount || data.rejects?.length || 0,
    acceptCount: data.acceptCount || 0,
    suggestedCount: data.suggestedCount || 0,
    issues: [],
    rejects: data.rejects || [],
  };

  // Analyze each reject
  for (const reject of analysis.rejects) {
    const issues = [];
    const mergedText = reject.mergedText || '';
    const reason = reject.resolverDecisionReason || '';
    const debug = reject.evidenceSearchDebug || {};

    // Check for specific issues
    if (debug.overlapCount === 0 && debug.candidatesFound > 0) {
      issues.push({
        type: 'SCORE_ZERO_BUG',
        detail: 'Candidates found but all scored 0 - likely token mismatch',
      });
    }

    if (reason === 'no_evidence' || !mergedText) {
      issues.push({
        type: 'NO_EVIDENCE',
        detail: 'No OCR text captured',
      });
    }

    if (reason === 'No candidates found') {
      issues.push({
        type: 'NO_CANDIDATES',
        detail: 'API search returned no results',
      });
    }

    if (reason === 'low_title_confidence') {
      issues.push({
        type: 'LOW_CONFIDENCE',
        detail: `Score too low: ${debug.topScores?.[0]?.score || 0}`,
      });
    }

    // Check for unfiltered noise
    const noisePatterns = [
      { pattern: /\bZEBBA\b/i, noise: 'ZEBBA' },
      { pattern: /\bFORK\b/i, noise: 'FORK' },
      { pattern: /\bBESTSELENG\b/i, noise: 'BESTSELENG' },
    ];
    for (const { pattern, noise } of noisePatterns) {
      if (pattern.test(mergedText)) {
        issues.push({
          type: 'UNFILTERED_NOISE',
          detail: `"${noise}" should be filtered`,
        });
      }
    }

    analysis.issues.push({
      bookId: reject.id,
      mergedText: mergedText.substring(0, 100),
      reason,
      issues,
    });
  }

  return analysis;
}

function writeClaudeInstructions(analysis) {
  const timestamp = new Date().toISOString();
  const instruction = `
---
**[${timestamp}]** AUTO-FIX DAEMON

**Cycle ${state.fixCycle + 1}** - ${analysis.rejectCount} rejects to fix

**Issues Found:**
${analysis.issues.map(r => `- ${r.bookId}: ${r.issues.map(i => i.type).join(', ') || 'Unknown'}`).join('\n')}

**Action Required:**
Analyze the rejects in ${DOCUMENTS_DIR} and fix the scoring/hypothesis code.
After fixing, rebuild the app with: npx react-native run-ios

**Rejects Summary:**
${JSON.stringify(analysis.issues.slice(0, 5), null, 2)}
`;

  fs.appendFileSync(INSTRUCTIONS_FILE, instruction);
}

function processNewRejects(file) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROCESSING: ${file.name}`);
  console.log(`Cycle: ${state.fixCycle + 1}`);
  console.log('='.repeat(60));

  const analysis = analyzeRejectsFile(file.path);

  console.log(`Total: ${analysis.totalBooks}, Rejects: ${analysis.rejectCount}`);
  console.log(`Accept: ${analysis.acceptCount}, Suggested: ${analysis.suggestedCount}`);

  if (analysis.rejectCount === 0) {
    console.log('\n🎉 NO REJECTS! All books resolved successfully!');
    sendTelegram(`🎉 *Success!* All ${analysis.totalBooks} books resolved!\n\nNo more rejects. The pipeline is working correctly.`);
    return;
  }

  // Log issues
  console.log('\nIssues found:');
  for (const reject of analysis.issues) {
    console.log(`  ${reject.bookId}: ${reject.issues.map(i => i.type).join(', ') || 'Unknown'}`);
  }

  // Write instructions for Claude Code
  writeClaudeInstructions(analysis);

  // Send Telegram notification
  const issuesSummary = analysis.issues
    .slice(0, 3)
    .map(r => `• ${r.mergedText.substring(0, 30)}... → ${r.issues[0]?.type || r.reason}`)
    .join('\n');

  sendTelegram(`🔄 *Auto-Fix Cycle ${state.fixCycle + 1}*

${analysis.rejectCount}/${analysis.totalBooks} books rejected

*Top Issues:*
${issuesSummary}

Fixing automatically...`);

  // Update state
  state.lastProcessedFile = file.name;
  state.lastProcessedTime = new Date().toISOString();
  state.fixCycle++;
  saveState();
}

function checkForNewRejects() {
  const latestFile = findLatestRejectsFile();

  if (!latestFile) return;

  // Check if this is a new file we haven't processed
  if (latestFile.name !== state.lastProcessedFile ||
      latestFile.mtime > new Date(state.lastProcessedTime || 0).getTime()) {
    processNewRejects(latestFile);
  }
}

function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            BookScanner Auto-Fix Daemon                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Watching for rejects and fixing automatically...');
  console.log(`Documents: ${DOCUMENTS_DIR}`);
  console.log('');
  console.log('Press Ctrl+C to stop\n');

  loadState();

  // Initial check
  checkForNewRejects();

  // Start watching
  setInterval(checkForNewRejects, CHECK_INTERVAL_MS);
}

main();
