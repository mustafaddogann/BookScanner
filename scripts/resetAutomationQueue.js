#!/usr/bin/env node
/**
 * Reset automation queue/state for the selected profile.
 *
 * Safe behavior:
 * - Archives current instruction/state files into automationHome/archive/
 * - Recreates an empty instructions.md
 * - Clears rescan_signal.json
 *
 * This script does NOT touch legacy profile unless invoked with
 * BOOKSCANNER_AUTOMATION_PROFILE=legacy.
 */

const fs = require('fs');
const path = require('path');
const {
  automationHome,
  instructionsFile,
  rescanSignalFile,
  getAgentName,
  ensureAutomationDirs,
} = require('./automationConfig');

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveDir = path.join(automationHome, 'archive', `reset-${timestamp}`);
const filesToArchive = [
  instructionsFile,
  path.join(automationHome, '.fix_watcher_state.json'),
  path.join(automationHome, '.fix_request_state.json'),
  path.join(automationHome, '.codex_auto_fix_state.json'),
  path.join(automationHome, '.codex_auto_fix.lock'),
  path.join(automationHome, 'codex_last_fix_message.txt'),
  path.join(automationHome, 'codex_last_fix_output.log'),
];

function archiveFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  const basename = path.basename(filePath);
  const target = path.join(archiveDir, basename);
  fs.renameSync(filePath, target);
  console.log(`Archived: ${filePath} -> ${target}`);
  return true;
}

function resetInstructions() {
  const header = [
    '# Automation Instructions',
    `# Reset at ${new Date().toISOString()}`,
    '# New FIX_REQUEST entries will be appended below.',
    '',
  ].join('\n');
  fs.writeFileSync(instructionsFile, header, 'utf8');
  console.log(`Initialized: ${instructionsFile}`);
}

function clearRescanSignal() {
  if (!fs.existsSync(rescanSignalFile)) {
    return;
  }
  fs.unlinkSync(rescanSignalFile);
  console.log(`Removed: ${rescanSignalFile}`);
}

function main() {
  ensureAutomationDirs();
  console.log(`Automation Home: ${automationHome}`);
  console.log(`Agent: ${getAgentName()}`);

  let archivedCount = 0;
  for (const filePath of filesToArchive) {
    if (archiveFile(filePath)) {
      archivedCount += 1;
    }
  }

  resetInstructions();
  clearRescanSignal();

  console.log(`Reset complete. Archived files: ${archivedCount}`);
}

main();

