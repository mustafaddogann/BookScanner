#!/usr/bin/env node
/**
 * Rejects Analysis Daemon
 *
 * Watches for new rejects files and:
 * 1. Runs analysis
 * 2. Sends summary to Telegram via ClawdBot
 * 3. Optionally triggers Claude Code for fixes
 *
 * Usage: node scripts/rejectsDaemon.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Configuration
const WATCH_DIRS = [
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'BookshelfOut'),
  path.join(os.homedir(), '.claude/clawdbot-instructions/documents'),
  // iCloud Drive - BookScanner folder
  path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/BookScanner'),
];

const STATE_FILE = path.join(__dirname, '.daemon_state.json');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');
const TELEGRAM_SEND = path.join(os.homedir(), '.claude/clawdbot-instructions/telegram-bot/send.py');

const CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { processedFiles: {}, lastCheck: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function findRejectFiles() {
  const files = [];
  for (const dir of WATCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('rejects_') && name.endsWith('.json')) {
          const filepath = path.join(dir, name);
          const stats = fs.statSync(filepath);
          files.push({
            path: filepath,
            mtime: stats.mtime.getTime(),
            size: stats.size,
          });
        }
      }
    } catch {
      // Directory might not be accessible
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function runAnalysis(filepath) {
  console.log(`\nAnalyzing: ${filepath}`);
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

function parseAnalysisOutput(output) {
  // Extract key stats from the analysis output
  const lines = output.split('\n');
  const summary = {
    totalBooks: 0,
    rejectCount: 0,
    issues: [],
    recommendations: [],
  };

  let inSummary = false;
  let inRecommendations = false;

  for (const line of lines) {
    if (line.includes('Total Books:')) {
      summary.totalBooks = parseInt(line.split(':')[1]) || 0;
    }
    if (line.includes('Rejected:')) {
      summary.rejectCount = parseInt(line.split(':')[1]) || 0;
    }
    if (line.includes('ISSUE SUMMARY')) {
      inSummary = true;
      inRecommendations = false;
    }
    if (line.includes('RECOMMENDED ACTIONS')) {
      inSummary = false;
      inRecommendations = true;
    }
    if (inSummary && line.match(/^\d+x -/)) {
      summary.issues.push(line.trim());
    }
    if (inRecommendations && line.match(/^\d+\./)) {
      summary.recommendations.push(line.trim());
    }
  }

  return summary;
}

function formatTelegramMessage(filepath, summary) {
  const filename = path.basename(filepath);
  let msg = `📊 *Rejects Analysis Complete*\n\n`;
  msg += `File: \`${filename}\`\n`;
  msg += `Total Books: ${summary.totalBooks}\n`;
  msg += `Rejected: ${summary.rejectCount}\n\n`;

  if (summary.issues.length > 0) {
    msg += `*Issues Found:*\n`;
    for (const issue of summary.issues.slice(0, 5)) {
      msg += `• ${issue}\n`;
    }
    if (summary.issues.length > 5) {
      msg += `  ... and ${summary.issues.length - 5} more\n`;
    }
    msg += '\n';
  }

  if (summary.recommendations.length > 0) {
    msg += `*Recommendations:*\n`;
    for (const rec of summary.recommendations.slice(0, 3)) {
      msg += `${rec}\n`;
    }
  }

  msg += `\n💡 Reply "fix issues" to trigger Claude Code`;

  return msg;
}

async function sendToTelegram(message) {
  if (!fs.existsSync(TELEGRAM_SEND)) {
    console.log('Telegram send script not found, skipping notification');
    console.log('Message would be:', message);
    return false;
  }

  try {
    execSync(`python3 "${TELEGRAM_SEND}" "${message.replace(/"/g, '\\"')}"`, {
      encoding: 'utf8',
    });
    console.log('Sent notification to Telegram');
    return true;
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
    return false;
  }
}

function processNewFile(filepath, state) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`NEW REJECTS FILE DETECTED`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Path: ${filepath}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // Run analysis
  const output = runAnalysis(filepath);
  console.log(output);

  // Parse and send to Telegram
  const summary = parseAnalysisOutput(output);
  const telegramMsg = formatTelegramMessage(filepath, summary);
  sendToTelegram(telegramMsg);

  // Mark as processed
  state.processedFiles[filepath] = {
    processedAt: new Date().toISOString(),
    summary,
  };
  saveState(state);

  return summary;
}

function checkForNewFiles(state) {
  const files = findRejectFiles();

  for (const file of files) {
    const processed = state.processedFiles[file.path];

    // Check if file is new or modified since last processing
    if (!processed || file.mtime > new Date(processed.processedAt).getTime()) {
      processNewFile(file.path, state);
    }
  }

  state.lastCheck = new Date().toISOString();
  saveState(state);
}

function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         BookScanner Rejects Analysis Daemon                ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Watching directories:');
  for (const dir of WATCH_DIRS) {
    const exists = fs.existsSync(dir);
    console.log(`  ${exists ? '✓' : '✗'} ${dir}`);
  }
  console.log('');
  console.log(`Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log('Press Ctrl+C to stop\n');

  // Ensure iCloud folder exists
  const icloudDir = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/BookScanner');
  if (!fs.existsSync(icloudDir)) {
    try {
      fs.mkdirSync(icloudDir, { recursive: true });
      console.log(`Created iCloud folder: ${icloudDir}`);
    } catch (err) {
      console.log(`Note: Could not create iCloud folder (${err.message})`);
    }
  }

  const state = loadState();

  // Initial check
  checkForNewFiles(state);

  // Start watching
  setInterval(() => {
    checkForNewFiles(state);
  }, CHECK_INTERVAL_MS);
}

main();
