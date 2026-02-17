#!/usr/bin/env node
/**
 * Write a rescan signal for the app's auto-rescan poller.
 *
 * Usage:
 *   node scripts/signalRescan.js "OCR fixes deployed"
 *   node scripts/signalRescan.js --reason "Try again" --no-auto-retry
 */

const fs = require('fs');
const {
  rescanSignalFile,
  ensureAutomationDirs,
} = require('./automationConfig');

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    reason: null,
    autoRetry: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-auto-retry') {
      options.autoRetry = false;
      continue;
    }
    if (arg === '--reason' && args[i + 1]) {
      options.reason = args[i + 1];
      i += 1;
      continue;
    }
    if (!arg.startsWith('--') && !options.reason) {
      options.reason = arg;
    }
  }

  return options;
}

function main() {
  ensureAutomationDirs();
  const options = parseArgs(process.argv);
  const payload = {
    rescan: true,
    auto_retry: options.autoRetry,
    reason: options.reason || 'Code changes deployed. Please rescan.',
    requestedAt: new Date().toISOString(),
  };

  fs.writeFileSync(rescanSignalFile, JSON.stringify(payload, null, 2));

  console.log('Rescan signal written.');
  console.log(`File: ${rescanSignalFile}`);
  console.log(JSON.stringify(payload, null, 2));
}

main();
