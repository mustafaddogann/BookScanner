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

const PORT = 8765;
const EXPORTS_DIR = path.join(os.homedir(), '.claude/clawdbot-instructions/documents');
const SCAN_IMAGES_DIR = path.join(os.homedir(), '.claude/clawdbot-instructions/scan-images');
const INSTRUCTIONS_FILE = path.join(os.homedir(), '.claude/clawdbot-instructions/instructions.md');
const ANALYZE_SCRIPT = path.join(__dirname, 'analyzeRejects.js');
const TELEGRAM_SEND = path.join(os.homedir(), '.claude/clawdbot-instructions/telegram-bot/send.py');
const AUTO_FIX_SCRIPT = path.join(os.homedir(), '.claude/clawdbot-instructions/auto-fix.py');
const RESCAN_SIGNAL_FILE = path.join(os.homedir(), '.claude/clawdbot-instructions/rescan_signal.json');

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

function writeFixRequest(filepath, summary, sessionId) {
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

function runAutoFix(filepath) {
  if (!fs.existsSync(AUTO_FIX_SCRIPT)) {
    console.log('Auto-fix script not available');
    return;
  }

  console.log('Running auto-fix analysis...');
  try {
    // Run async - don't block the response
    const { spawn } = require('child_process');
    const proc = spawn('python3', [AUTO_FIX_SCRIPT, filepath], {
      detached: true,
      stdio: 'ignore'
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
          writeFixRequest(filepath, summary, sessionId);
          runAutoFix(filepath);
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
  console.log('Configure your iOS app with this URL:');
  console.log(`  http://${localIP}:${PORT}/upload`);
  console.log('');
  console.log('Press Ctrl+C to stop\n');
});
