#!/usr/bin/env node
/**
 * Check ClawdBot instructions for rejects analysis requests
 *
 * Reads ~/.claude/clawdbot-instructions/instructions.md and processes
 * any "analyze rejects" commands.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const INSTRUCTIONS_FILE = path.join(os.homedir(), '.claude/clawdbot-instructions/instructions.md');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');
const WATCH_SCRIPT = path.join(__dirname, 'watchRejects.js');

// Track which instructions we've already processed
const PROCESSED_FILE = path.join(__dirname, '.processed_instructions.json');

function loadProcessed() {
  if (fs.existsSync(PROCESSED_FILE)) {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'));
  }
  return { lastCheck: null, processedLines: [] };
}

function saveProcessed(data) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(data, null, 2));
}

function parseInstructions() {
  if (!fs.existsSync(INSTRUCTIONS_FILE)) {
    console.log('No instructions file found');
    return [];
  }

  const content = fs.readFileSync(INSTRUCTIONS_FILE, 'utf8');
  const entries = [];

  // Parse entries (format: ---\n**[timestamp]** From: user\n\ncontent\n)
  const blocks = content.split(/^---$/m).filter(b => b.trim());

  for (const block of blocks) {
    const timestampMatch = block.match(/\*\*\[([^\]]+)\]\*\*/);
    const photoMatch = block.match(/\[Photo:\s*([^\]]+)\]/);
    const documentMatch = block.match(/\[Document:\s*([^\]]+)\]/);
    const messageMatch = block.match(/From:.*?\n\n([\s\S]*?)$/);

    if (timestampMatch) {
      entries.push({
        timestamp: timestampMatch[1],
        photo: photoMatch ? photoMatch[1].trim() : null,
        document: documentMatch ? documentMatch[1].trim() : null,
        message: messageMatch ? messageMatch[1].trim() : '',
      });
    }
  }

  return entries;
}

function processEntry(entry) {
  const msg = entry.message.toLowerCase();

  // Check for analyze rejects commands
  if (msg.includes('analyze') && (msg.includes('reject') || msg.includes('rejects'))) {
    console.log(`\nProcessing: "${entry.message}"`);

    // If there's a document path, analyze it directly
    if (entry.document && fs.existsSync(entry.document)) {
      console.log(`Analyzing document: ${entry.document}`);
      execSync(`node "${ANALYZE_SCRIPT}" "${entry.document}"`, { stdio: 'inherit' });
      return true;
    }

    // Otherwise, run the watch script to find new files
    console.log('Running watch script to find new rejects files...');
    execSync(`node "${WATCH_SCRIPT}" --once`, { stdio: 'inherit' });
    return true;
  }

  // Check for "check rejects" or similar
  if (msg.includes('check') && (msg.includes('reject') || msg.includes('new'))) {
    console.log('Running watch script...');
    execSync(`node "${WATCH_SCRIPT}" --once`, { stdio: 'inherit' });
    return true;
  }

  return false;
}

function main() {
  console.log('Checking ClawdBot instructions...\n');

  const processed = loadProcessed();
  const entries = parseInstructions();

  // Find new entries (by timestamp)
  const newEntries = entries.filter(e => !processed.processedLines.includes(e.timestamp));

  if (newEntries.length === 0) {
    console.log('No new instructions to process.');
    return;
  }

  console.log(`Found ${newEntries.length} new instruction(s)`);

  for (const entry of newEntries) {
    const wasProcessed = processEntry(entry);
    if (wasProcessed) {
      console.log(`✓ Processed instruction from ${entry.timestamp}`);
    }
    processed.processedLines.push(entry.timestamp);
  }

  processed.lastCheck = new Date().toISOString();
  saveProcessed(processed);
}

main();
