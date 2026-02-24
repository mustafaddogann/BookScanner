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
const { execSync } = require('child_process');
const os = require('os');

const PORT = parseInt(process.env.BOOKSCANNER_SERVER_PORT || '8765', 10);

// Profile-aware paths: codex profile uses codex-bookscanner-loop, legacy uses clawdbot-instructions
const AUTOMATION_PROFILE = (process.env.BOOKSCANNER_AUTOMATION_PROFILE || 'codex').toLowerCase();
const AUTOMATION_HOME = process.env.BOOKSCANNER_AUTOMATION_HOME ||
  path.join(os.homedir(), AUTOMATION_PROFILE === 'legacy'
    ? '.claude/clawdbot-instructions'
    : '.claude/codex-bookscanner-loop');

const EXPORTS_DIR = path.join(AUTOMATION_HOME, 'documents');
const SCAN_IMAGES_DIR = path.join(AUTOMATION_HOME, 'scan-images');
const INSTRUCTIONS_FILE = path.join(AUTOMATION_HOME, 'instructions.md');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');
const TELEGRAM_SEND = path.join(AUTOMATION_HOME, 'telegram-bot/send.py');
const AUTO_FIX_SCRIPT = path.join(__dirname, 'auto-fix.py');
const AUTO_FIX_LOG = path.join(AUTOMATION_HOME, 'auto-fix.log');
const RESCAN_SIGNAL_FILE = path.join(AUTOMATION_HOME, 'rescan_signal.json');

// Dedup: track what we've already written/spawned
const DEDUP_WINDOW_SEC = parseInt(process.env.BOOKSCANNER_SERVER_DUPLICATE_WINDOW_SEC || '45', 10);
let lastFixRequestHash = null;
let lastFixRequestTime = 0;
let lastAutoFixHash = null;
let lastAutoFixTime = 0;

function rejectPayloadHash(data) {
  const crypto = require('crypto');
  const rejects = (data.rejects || []).map(r =>
    `${r.id || ''}|${r.resolverDecisionReason || ''}|${(r.mergedText || '').substring(0, 80)}`
  );
  rejects.sort();
  return crypto.createHash('sha1').update(rejects.join('\n')).digest('hex').substring(0, 12);
}

// Track latest analysis result
let latestAnalysis = {
  sessionId: null,
  rejectCount: 0,
  fixable: false,
  timestamp: null,
  recommendation: null
};

// Ensure directories exist
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}
if (!fs.existsSync(SCAN_IMAGES_DIR)) {
  fs.mkdirSync(SCAN_IMAGES_DIR, { recursive: true });
}

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
  if (!fs.existsSync(TELEGRAM_SEND)) {
    console.log('Telegram send not available');
    return false;
  }

  try {
    // Use stdin piping to avoid shell escaping issues with special chars
    execSync(`python3 "${TELEGRAM_SEND}"`, {
      input: message,
      encoding: 'utf8',
    });
    console.log('Telegram notification sent');
    return true;
  } catch (err) {
    console.error('Telegram send failed:', err.message);
    return false;
  }
}

function writeFixRequest(filepath, summary, sessionId, payloadHash) {
  // Dedup: skip if same payload hash within window
  const now = Date.now();
  if (payloadHash === lastFixRequestHash && (now - lastFixRequestTime) < DEDUP_WINDOW_SEC * 1000) {
    console.log(`FIX_REQUEST skipped (duplicate within ${DEDUP_WINDOW_SEC}s)`);
    return false;
  }
  lastFixRequestHash = payloadHash;
  lastFixRequestTime = now;

  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const issues = summary.issues.slice(0, 3).join('; ') || 'Unknown issues';

  const instruction = `
---
**[${timestamp}]** ACTION: FIX_REQUEST
From: auto-rejects-server

**Problem:** ${summary.rejectCount} books rejected out of ${summary.totalBooks}
**Rejects File:** ${filepath}
**Error:** ${issues}
**Context:** Auto-triggered by rejects upload from session ${sessionId}

---`;

  try {
    fs.appendFileSync(INSTRUCTIONS_FILE, instruction);
    console.log('FIX_REQUEST written to instructions.md');
    return true;
  } catch (err) {
    console.error('Failed to write FIX_REQUEST:', err.message);
    return false;
  }
}

function runAutoFix(filepath, payloadHash) {
  if (!fs.existsSync(AUTO_FIX_SCRIPT)) {
    console.log('Auto-fix script not available');
    return;
  }

  // Dedup: don't spawn auto-fix for same payload within cooldown
  const now = Date.now();
  const AUTO_FIX_COOLDOWN_MS = 120000; // 2 min — give codex time to work
  if (payloadHash === lastAutoFixHash && (now - lastAutoFixTime) < AUTO_FIX_COOLDOWN_MS) {
    console.log(`Auto-fix skipped (same payload, cooldown ${AUTO_FIX_COOLDOWN_MS / 1000}s)`);
    return;
  }
  lastAutoFixHash = payloadHash;
  lastAutoFixTime = now;

  console.log(`Running auto-fix (profile=${AUTOMATION_PROFILE}, hash=${payloadHash})...`);
  try {
    const { spawn } = require('child_process');
    const localBin = path.join(os.homedir(), '.local/bin');
    const envPath = process.env.PATH || '';
    const childEnv = {
      ...process.env,
      PATH: envPath.includes(localBin) ? envPath : `${localBin}:${envPath}`,
      BOOKSCANNER_AUTOMATION_PROFILE: AUTOMATION_PROFILE,
      BOOKSCANNER_AUTOMATION_HOME: AUTOMATION_HOME,
    };
    // Log output to file instead of discarding
    const logFd = fs.openSync(AUTO_FIX_LOG, 'a');
    fs.writeSync(logFd, `\n--- auto-fix spawned at ${new Date().toISOString()} for ${path.basename(filepath)} ---\n`);
    const proc = spawn('python3', [AUTO_FIX_SCRIPT, filepath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    });
    proc.unref();
    // Close fd in parent after spawn
    fs.closeSync(logFd);
    console.log(`Auto-fix started (log: ${AUTO_FIX_LOG})`);
  } catch (err) {
    console.error('Auto-fix failed:', err.message);
  }
}

const server = http.createServer((req, res) => {
  // CORS headers for local network
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
        const filepath = path.join(EXPORTS_DIR, filename);

        // Save the file
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        console.log(`\n${'='.repeat(60)}`);
        console.log(`RECEIVED: ${filename}`);
        console.log(`Rejects: ${data.rejectCount || data.rejects?.length || 0}`);
        console.log(`${'='.repeat(60)}`);

        // Run analysis
        const analysisOutput = runAnalysis(filepath);
        console.log(analysisOutput);

        // Parse and send to Telegram
        const summary = parseAnalysisOutput(analysisOutput);

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
        if (summary.rejectCount > 0) {
          const hash = rejectPayloadHash(data);
          writeFixRequest(filepath, summary, sessionId, hash);
          runAutoFix(filepath, hash);
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

    if (fs.existsSync(RESCAN_SIGNAL_FILE)) {
      try {
        signal = JSON.parse(fs.readFileSync(RESCAN_SIGNAL_FILE, 'utf8'));
        // Clear the signal after reading
        fs.unlinkSync(RESCAN_SIGNAL_FILE);
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
    if (fs.existsSync(RESCAN_SIGNAL_FILE)) {
      try {
        fs.unlinkSync(RESCAN_SIGNAL_FILE);
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
        const filepath = path.join(SCAN_IMAGES_DIR, filename);
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
    const filepath = path.join(SCAN_IMAGES_DIR, `scan_${sessionId}.jpg`);

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
  console.log('║         BookScanner Rejects Upload Server                  ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Server running on:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}`);
  console.log('');
  console.log(`Profile: ${AUTOMATION_PROFILE}`);
  console.log(`Home:    ${AUTOMATION_HOME}`);
  console.log('');
  console.log('Configure your iOS app with this URL:');
  console.log(`  http://${localIP}:${PORT}/upload`);
  console.log('');
  console.log('Press Ctrl+C to stop\n');
});
