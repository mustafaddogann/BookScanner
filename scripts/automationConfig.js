#!/usr/bin/env node
/**
 * Shared configuration for the rejects/rescan automation loop.
 *
 * Default profile is auto (preserve existing legacy Claude setup).
 * Set env vars to override:
 * - BOOKSCANNER_AUTOMATION_PROFILE=codex|legacy|auto
 * - BOOKSCANNER_AUTOMATION_HOME=/absolute/path
 * - BOOKSCANNER_SERVER_PORT=8765
 * - BOOKSCANNER_AGENT_NAME=Codex
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SERVER_PORT = 8765;
const LEGACY_AUTOMATION_HOME = path.join(os.homedir(), '.claude', 'clawdbot-instructions');
const CODEX_AUTOMATION_HOME = path.join(os.homedir(), '.claude', 'codex-bookscanner-loop');

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveAutomationHome() {
  const explicitHome = process.env.BOOKSCANNER_AUTOMATION_HOME;
  if (explicitHome) {
    return path.resolve(expandHome(explicitHome));
  }

  const profile = (process.env.BOOKSCANNER_AUTOMATION_PROFILE || 'auto').toLowerCase();
  if (profile === 'legacy') {
    return LEGACY_AUTOMATION_HOME;
  }
  if (profile === 'codex') {
    return CODEX_AUTOMATION_HOME;
  }
  if (profile === 'auto') {
    // Backward-compatible default: keep using legacy home if it already exists.
    if (fs.existsSync(LEGACY_AUTOMATION_HOME)) {
      return LEGACY_AUTOMATION_HOME;
    }
    return CODEX_AUTOMATION_HOME;
  }

  return LEGACY_AUTOMATION_HOME;
}

const automationHome = resolveAutomationHome();
const documentsDir = path.join(automationHome, 'documents');
const scanImagesDir = path.join(automationHome, 'scan-images');
const instructionsFile = path.join(automationHome, 'instructions.md');
const preferredTelegramSendScript = path.join(automationHome, 'telegram-bot', 'send.py');
const legacyTelegramSendScript = path.join(LEGACY_AUTOMATION_HOME, 'telegram-bot', 'send.py');
const codexTelegramSendScript = path.join(CODEX_AUTOMATION_HOME, 'telegram-bot', 'send.py');
const preferredAutoFixScript = path.join(automationHome, 'auto-fix.py');
const workspaceAutoFixScript = path.join(__dirname, 'auto-fix.py');

function resolveTelegramSendScript() {
  if (fs.existsSync(preferredTelegramSendScript)) {
    return preferredTelegramSendScript;
  }

  // Keep Telegram notifications working when one profile is missing telegram-bot setup.
  if (fs.existsSync(legacyTelegramSendScript)) {
    return legacyTelegramSendScript;
  }
  if (fs.existsSync(codexTelegramSendScript)) {
    return codexTelegramSendScript;
  }

  // Default to preferred path when none exist (callers handle missing file).
  return preferredTelegramSendScript;
}

const telegramSendScript = resolveTelegramSendScript();

function resolveAutoFixScript() {
  if (fs.existsSync(preferredAutoFixScript)) {
    return preferredAutoFixScript;
  }

  // Workspace fallback: use repo-managed auto-fix runner when profile home lacks script.
  if (fs.existsSync(workspaceAutoFixScript)) {
    return workspaceAutoFixScript;
  }

  return preferredAutoFixScript;
}

const autoFixScript = resolveAutoFixScript();
const rescanSignalFile = path.join(automationHome, 'rescan_signal.json');

function ensureAutomationDirs() {
  const dirs = [automationHome, documentsDir, scanImagesDir];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function getServerPort() {
  const raw = process.env.BOOKSCANNER_SERVER_PORT;
  if (!raw) return DEFAULT_SERVER_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_SERVER_PORT;
  }
  return parsed;
}

function getAgentName() {
  if (process.env.BOOKSCANNER_AGENT_NAME) {
    return process.env.BOOKSCANNER_AGENT_NAME;
  }
  if (automationHome === LEGACY_AUTOMATION_HOME) {
    return 'Claude';
  }
  return 'Codex';
}

function getWatchDirs() {
  return [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'BookshelfOut'),
    documentsDir,
    path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/BookScanner'),
  ];
}

module.exports = {
  DEFAULT_SERVER_PORT,
  LEGACY_AUTOMATION_HOME,
  CODEX_AUTOMATION_HOME,
  automationHome,
  documentsDir,
  scanImagesDir,
  instructionsFile,
  telegramSendScript,
  autoFixScript,
  rescanSignalFile,
  getServerPort,
  getAgentName,
  getWatchDirs,
  ensureAutomationDirs,
};
