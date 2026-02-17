#!/usr/bin/env node
/**
 * Start the local automation loop processes together:
 * - rejectsServer.js
 * - autoFixDaemon.js
 */

const path = require('path');
const { spawn } = require('child_process');
const { getAgentName } = require('./automationConfig');

const agentName = getAgentName();
const triggerMode = (
  process.env.BOOKSCANNER_AUTOFIX_TRIGGER_MODE ||
  (agentName === 'Codex' ? 'daemon' : 'server')
).toLowerCase();
const explicitDaemonFlag = process.env.BOOKSCANNER_START_DAEMON;
const shouldRunDaemon =
  explicitDaemonFlag != null
    ? explicitDaemonFlag === '1'
    : triggerMode === 'daemon';

const processes = [
  { name: 'server', script: 'rejectsServer.js' },
  ...(shouldRunDaemon ? [{ name: 'daemon', script: 'autoFixDaemon.js' }] : []),
];

function forwardOutput(stream, prefix) {
  stream.on('data', (chunk) => {
    process.stdout.write(`[${prefix}] ${chunk.toString()}`);
  });
}

const children = processes.map(({ name, script }) => {
  const child = spawn(process.execPath, [path.join(__dirname, script)], {
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  forwardOutput(child.stdout, name);
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });

  return { name, child };
});

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(exitCode), 300);
}

for (const { name, child } of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal=${signal}` : `code=${code}`;
    console.error(`[${name}] exited (${reason})`);
    shutdown(code || 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Automation loop started. Press Ctrl+C to stop.');
if (!shouldRunDaemon) {
  console.log('Daemon disabled for this run (server-only mode).');
}
