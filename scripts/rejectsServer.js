#!/usr/bin/env node
/**
 * Rejects Upload Server
 *
 * Simple HTTP server that receives rejects JSON from the iOS app.
 * Runs on the local network so the app can upload directly.
 *
 * Usage: node scripts/rejectsServer.js
 *
 * The app POSTs to: http://<mac-ip>:8765/upload
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const os = require('os');
const {
  automationHome,
  documentsDir,
  scanImagesDir,
  instructionsFile,
  telegramSendScript,
  autoFixScript,
  rescanSignalFile,
  getServerPort,
  getAgentName,
  ensureAutomationDirs,
} = require('./automationConfig');

const PORT = getServerPort();
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');
const AGENT_NAME = getAgentName();
const AUTOFIX_TRIGGER_MODE = (
  process.env.BOOKSCANNER_AUTOFIX_TRIGGER_MODE ||
  (AGENT_NAME === 'Codex' ? 'daemon' : 'server')
).toLowerCase();
const FIX_REQUEST_STATE_FILE = path.join(automationHome, '.fix_request_state.json');
const FIX_WATCHER_STATE_FILE = path.join(automationHome, '.fix_watcher_state.json');
const FIX_REQUEST_COOLDOWN_SEC = Number.parseInt(
  process.env.BOOKSCANNER_SERVER_REQUEST_COOLDOWN_SEC || '45',
  10
);
const DEFAULT_DUPLICATE_WINDOW_SEC = FIX_REQUEST_COOLDOWN_SEC;
const FIX_REQUEST_DUPLICATE_WINDOW_SEC = Number.parseInt(
  process.env.BOOKSCANNER_SERVER_DUPLICATE_WINDOW_SEC ||
    `${DEFAULT_DUPLICATE_WINDOW_SEC}`,
  10
);
const ACTIVE_REQUEST_MAX_AGE_SEC = Number.parseInt(
  process.env.BOOKSCANNER_SERVER_ACTIVE_REQUEST_MAX_AGE_SEC || '7200',
  10
);

// Track latest analysis result
let latestAnalysis = {
  sessionId: null,
  rejectCount: 0,
  fixable: false,
  timestamp: null,
  recommendation: null
};

// Ensure directories exist
ensureAutomationDirs();

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
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

function parseAnalysisOutput(output) {
  const summary = {
    totalBooks: 0,
    rejectCount: 0,
    issues: [],
    recommendations: [],
  };

  const lines = output.split('\n');
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

function sendToTelegram(message) {
  if (!fs.existsSync(telegramSendScript)) {
    console.log('Telegram send not available');
    return false;
  }

  try {
    // Use stdin piping to avoid shell escaping issues with special chars
    execSync(`python3 "${telegramSendScript}"`, {
      input: message,
      encoding: 'utf8',
      timeout: 15000,
    });
    console.log('Telegram notification sent');
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    return false;
  }
}

function loadFixRequestState() {
  if (!fs.existsSync(FIX_REQUEST_STATE_FILE)) {
    return { recent: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FIX_REQUEST_STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.recent && typeof parsed.recent === 'object') {
      return parsed;
    }
  } catch (_err) {
    // ignore parse failures; start clean
  }
  return { recent: {} };
}

function saveFixRequestState(state) {
  try {
    fs.writeFileSync(FIX_REQUEST_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Failed to save FIX_REQUEST state:', err.message);
  }
}

function computeRejectsFingerprint(data) {
  const rejects = Array.isArray(data.rejects) ? data.rejects : [];
  const rows = rejects
    .map((item) => {
      const id = String(item.id || '');
      const reason = String(item.resolverDecisionReason || '');
      const mergedText = String(item.mergedText || '').slice(0, 160);
      return `${id}|${reason}|${mergedText}`;
    })
    .sort()
    .join('\n');
  return crypto.createHash('sha1').update(rows).digest('hex');
}

function shouldQueueFixRequest(sessionId, fingerprint) {
  if (!fingerprint) return true;

  const state = loadFixRequestState();
  const key = `${sessionId}|${fingerprint}`;
  const lastQueuedAt = state.recent[key];
  const nowMs = Date.now();
  const withinDuplicateWindow =
    typeof lastQueuedAt === 'number' &&
    nowMs - lastQueuedAt < FIX_REQUEST_DUPLICATE_WINDOW_SEC * 1000;

  if (withinDuplicateWindow) {
    return false;
  }

  state.recent[key] = nowMs;

  // Compact stale entries to keep state small.
  const maxAgeMs = FIX_REQUEST_DUPLICATE_WINDOW_SEC * 1000 * 2;
  const compacted = {};
  for (const [stateKey, ts] of Object.entries(state.recent)) {
    if (typeof ts === 'number' && nowMs - ts < maxAgeMs) {
      compacted[stateKey] = ts;
    }
  }
  state.recent = compacted;
  saveFixRequestState(state);
  return true;
}

function hasActiveFixForSession(sessionId) {
  if (!fs.existsSync(FIX_WATCHER_STATE_FILE)) {
    return false;
  }

  try {
    const state = JSON.parse(fs.readFileSync(FIX_WATCHER_STATE_FILE, 'utf8'));
    const active = state?.activeRequest;
    if (!active || active.sessionId !== sessionId) {
      return false;
    }

    const startedAtMs = new Date(active.startedAt || 0).getTime();
    if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
      return true;
    }

    const ageMs = Date.now() - startedAtMs;
    return ageMs < ACTIVE_REQUEST_MAX_AGE_SEC * 1000;
  } catch (_err) {
    return false;
  }
}

function writeFixRequest(filepath, summary, sessionId) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const issues = summary.issues.slice(0, 3).join('; ') || 'Unknown issues';
  const requestId = `${sessionId}_${Date.now().toString(36)}_${crypto
    .createHash('sha1')
    .update(`${filepath}|${timestamp}`)
    .digest('hex')
    .slice(0, 6)}`;

  const instruction = `
---
**[${timestamp}]** ACTION: FIX_REQUEST
From: auto-rejects-server
**Request ID:** ${requestId}

**Problem:** ${summary.rejectCount} books rejected out of ${summary.totalBooks}
**Rejects File:** ${filepath}
**Error:** ${issues}
**Context:** Auto-triggered by rejects upload from session ${sessionId}

---`;

  try {
    fs.appendFileSync(instructionsFile, instruction);
    console.log(`FIX_REQUEST written to instructions.md (requestId=${requestId})`);
    return { ok: true, requestId };
  } catch (err) {
    console.error('Failed to write FIX_REQUEST:', err.message);
    return { ok: false, requestId: null };
  }
}

function runAutoFix(filepath, requestId = null) {
  if (!fs.existsSync(autoFixScript)) {
    console.log('Auto-fix script not available');
    return;
  }

  console.log(`Running auto-fix analysis${requestId ? ` (requestId=${requestId})` : ''}...`);
  try {
    // Run async - don't block the response
    const { spawn } = require('child_process');
    const autoFixLogFile = path.join(automationHome, 'auto-fix.log');
    const logFd = fs.openSync(autoFixLogFile, 'a');
    const proc = spawn('python3', [autoFixScript, filepath], {
      env: {
        ...process.env,
        BOOKSCANNER_AUTOMATION_HOME: automationHome,
        BOOKSCANNER_PROJECT_DIR: path.resolve(__dirname, '..'),
      },
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
    proc.unref();
    console.log('Auto-fix analysis started in background');
  } catch (err) {
    console.error('Auto-fix failed:', err.message);
  }
}

const server = http.createServer((req, res) => {
  // CORS headers for local network
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/upload') {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
      // Limit body size to 10MB
      if (body.length > 10 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const sessionId = data.sessionId || 'unknown';
        const timestamp = Date.now();
        const filename = `rejects_${sessionId}_${timestamp}.json`;
        const filepath = path.join(documentsDir, filename);

        // Save the file
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        console.log(`\n${'='.repeat(60)}`);
        console.log(`RECEIVED: ${filename}`);
        console.log(`Rejects: ${data.rejectCount || data.rejects?.length || 0}`);
        console.log(`${'='.repeat(60)}`);

        // Run analysis
        const analysisOutput = runAnalysis(filepath);
        console.log(analysisOutput);

        // Parse analysis output
        const summary = parseAnalysisOutput(analysisOutput);
        const hasRejects = summary.rejectCount > 0;
        const rejectsFingerprint = hasRejects ? computeRejectsFingerprint(data) : null;
        const activeFixInProgress = hasRejects && hasActiveFixForSession(sessionId);
        const shouldQueue =
          hasRejects &&
          !activeFixInProgress &&
          shouldQueueFixRequest(sessionId, rejectsFingerprint);

        if (hasRejects && shouldQueue) {
          let telegramMsg = `📊 *New Rejects Received*\n\n`;
          telegramMsg += `Session: \`${sessionId}\`\n`;
          telegramMsg += `Total: ${summary.totalBooks} books\n`;
          telegramMsg += `Rejected: ${summary.rejectCount}\n\n`;

          if (summary.issues.length > 0) {
            telegramMsg += `*Top Issues:*\n`;
            for (const issue of summary.issues.slice(0, 3)) {
              telegramMsg += `• ${issue}\n`;
            }
          }

          sendToTelegram(telegramMsg);
        }

        // Update latest analysis
        latestAnalysis = {
          sessionId,
          rejectCount: summary.rejectCount,
          totalBooks: summary.totalBooks,
          fixable: false,  // Will be updated by auto-fix script
          timestamp: new Date().toISOString(),
          issues: summary.issues.slice(0, 3)
        };

        // Auto-trigger analysis
        if (hasRejects) {
          if (activeFixInProgress) {
            console.log(
              `Skipping FIX_REQUEST because active fix is already running for session=${sessionId}`
            );
          } else if (!shouldQueue) {
            console.log(
              `Skipping duplicate FIX_REQUEST within dedupe window (${FIX_REQUEST_DUPLICATE_WINDOW_SEC}s) for session=${sessionId}`
            );
          } else {
            const fixRequest = writeFixRequest(filepath, summary, sessionId);
            if (AUTOFIX_TRIGGER_MODE === 'server') {
              runAutoFix(filepath, fixRequest.requestId);
            } else {
              console.log(`Auto-fix queued for daemon (mode=${AUTOFIX_TRIGGER_MODE})`);
            }
          }
        } else {
          // All books accepted!
          sendToTelegram(`🎉 *Tüm kitaplar kabul edildi!* (${summary.totalBooks}/${summary.totalBooks})`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          filename,
          summary,
        }));

      } catch (err) {
        console.error('Error processing upload:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));

  } else if (req.method === 'GET' && req.url === '/rescan-status') {
    // Check if there's a rescan signal
    let signal = { rescan: false, reason: null };

    if (fs.existsSync(rescanSignalFile)) {
      try {
        signal = JSON.parse(fs.readFileSync(rescanSignalFile, 'utf8'));
        // Clear the signal after reading
        fs.unlinkSync(rescanSignalFile);
        console.log('Rescan signal consumed by app');
      } catch (err) {
        console.error('Error reading rescan signal:', err.message);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...signal,
      latestAnalysis
    }));

  } else if (req.method === 'GET' && req.url === '/analysis-status') {
    // Get latest analysis without consuming rescan signal
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestAnalysis));

  } else if (req.method === 'POST' && req.url === '/clear-rescan') {
    // Clear rescan signal explicitly
    if (fs.existsSync(rescanSignalFile)) {
      try {
        fs.unlinkSync(rescanSignalFile);
        console.log('Rescan signal cleared by app');
      } catch (err) {
        console.error('Error clearing rescan signal:', err.message);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));

  } else if (req.method === 'POST' && req.url === '/upload-scan-image') {
    // Receive scan image as base64 JSON
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
      // Limit to 50MB for images
      if (body.length > 50 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const sessionId = data.sessionId || 'unknown';
        const imageBase64 = data.imageBase64;

        if (!imageBase64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No image data provided' }));
          return;
        }

        // Save the image
        const filename = `scan_${sessionId}.jpg`;
        const filepath = path.join(scanImagesDir, filename);
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        fs.writeFileSync(filepath, imageBuffer);

        console.log(`Scan image saved: ${filename} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, filename }));

      } catch (err) {
        console.error('Error saving scan image:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

  } else if (req.method === 'GET' && req.url.startsWith('/scan-image/')) {
    // Serve scan image for a session
    const sessionId = req.url.replace('/scan-image/', '');
    const filepath = path.join(scanImagesDir, `scan_${sessionId}.jpg`);

    if (fs.existsSync(filepath)) {
      const imageBuffer = fs.readFileSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': imageBuffer.length
      });
      res.end(imageBuffer);
      console.log(`Scan image served: scan_${sessionId}.jpg`);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Image not found' }));
    }

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║      BookScanner Automation Rejects Upload Server          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Automation Home: ${automationHome}`);
  console.log(`Agent: ${AGENT_NAME}`);
  console.log('');
  console.log(`Server running on:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}`);
  console.log('');
  console.log('Configure your iOS app with this URL:');
  console.log(`  http://${localIP}:${PORT}/upload`);
  console.log('');
  console.log('Press Ctrl+C to stop\n');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Set BOOKSCANNER_SERVER_PORT to a free port and restart.`
    );
  } else {
    console.error('Rejects server failed:', err?.message || err);
  }
  process.exit(1);
});
