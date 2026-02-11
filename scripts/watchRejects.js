#!/usr/bin/env node
/**
 * Watch for new Rejects JSON files and analyze them
 *
 * Usage: node scripts/watchRejects.js [--once]
 *
 * Watches ~/Downloads and ~/Documents for rejects_*.json files
 * and runs analysis on any new ones.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WATCH_DIRS = [
  path.join(require('os').homedir(), 'Downloads'),
  path.join(require('os').homedir(), 'Documents'),
  path.join(require('os').homedir(), 'BookshelfOut'),
  path.join(require('os').homedir(), '.claude/clawdbot-instructions/documents'),
];

const PROCESSED_FILE = path.join(__dirname, '.processed_rejects.json');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');

function loadProcessed() {
  if (fs.existsSync(PROCESSED_FILE)) {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
  }
  return { files: [] };
}

function saveProcessed(data) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
}

function findRejectFiles() {
  const files = [];
  for (const dir of WATCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('rejects_') && name.endsWith('.json')) {
        files.push(path.join(dir, name));
      }
    }
  }
  return files;
}

function analyzeFile(filepath) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ANALYZING: ${filepath}`);
  console.log('='.repeat(60));

  try {
    execSync(`node "${ANALYZE_SCRIPT}" "${filepath}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Error analyzing ${filepath}:`, err.message);
  }
}

function checkForNewFiles() {
  const processed = loadProcessed();
  const allFiles = findRejectFiles();

  // Sort by mtime to get newest first
  allFiles.sort((a, b) => {
    return fs.statSync(b).mtime - fs.statSync(a).mtime;
  });

  const newFiles = allFiles.filter(f => !processed.files.includes(f));

  if (newFiles.length === 0) {
    console.log('No new rejects files found.');
    console.log(`Watched directories: ${WATCH_DIRS.join(', ')}`);
    return false;
  }

  console.log(`Found ${newFiles.length} new rejects file(s)`);

  for (const file of newFiles) {
    analyzeFile(file);
    processed.files.push(file);
  }

  saveProcessed(processed);
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');

  console.log('BookScanner Rejects Watcher');
  console.log(`Watching: ${WATCH_DIRS.join(', ')}`);
  console.log('');

  if (once) {
    // Single check mode
    checkForNewFiles();
  } else {
    // Watch mode - check every 5 seconds
    console.log('Running in watch mode (Ctrl+C to stop)...\n');
    checkForNewFiles();

    setInterval(() => {
      const found = checkForNewFiles();
      if (!found) {
        process.stdout.write('.');
      }
    }, 5000);
  }
}

main();
