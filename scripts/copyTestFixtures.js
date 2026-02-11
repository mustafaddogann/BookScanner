#!/usr/bin/env node
/**
 * Copy Test Fixtures to iOS Simulator/Device
 *
 * This script copies test shelf images to a location accessible by the app.
 * Run this after deploying the app to have test fixtures available.
 *
 * Usage: node scripts/copyTestFixtures.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FIXTURES_DIR = path.join(__dirname, '..', 'test_fixtures', 'shelves');
const FIXTURES = ['shelf_001.jpg', 'shelf_002.jpg'];

// Get the app's shared container path (for real device)
// For simulator, we use a different approach
function getSimulatorDataPath() {
  try {
    // Find booted simulator
    const result = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
    const devices = JSON.parse(result);

    for (const runtime of Object.values(devices.devices)) {
      for (const device of runtime) {
        if (device.state === 'Booted') {
          return execSync(`xcrun simctl get_app_container booted com.mustafa.openshelves data`, { encoding: 'utf8' }).trim();
        }
      }
    }
  } catch (e) {
    console.log('No booted simulator found');
  }
  return null;
}

async function main() {
  console.log('📁 Test Fixtures Copy Utility');
  console.log('==============================\n');

  // Check source files exist
  for (const fixture of FIXTURES) {
    const src = path.join(FIXTURES_DIR, fixture);
    if (!fs.existsSync(src)) {
      console.error(`❌ Missing fixture: ${src}`);
      process.exit(1);
    }
    console.log(`✅ Found: ${fixture}`);
  }

  // Try simulator first
  const simPath = getSimulatorDataPath();
  if (simPath) {
    const destDir = path.join(simPath, 'Documents', 'TestFixtures');
    fs.mkdirSync(destDir, { recursive: true });

    for (const fixture of FIXTURES) {
      const src = path.join(FIXTURES_DIR, fixture);
      const dest = path.join(destDir, fixture);
      fs.copyFileSync(src, dest);
      console.log(`📋 Copied to simulator: ${fixture}`);
    }

    console.log(`\n✅ Fixtures copied to: ${destDir}`);
    console.log('\nIn the app, use Settings → Developer → Load Test Fixture');
    return;
  }

  // For real device, show instructions
  console.log('\n📱 For real device, use one of these methods:');
  console.log('1. AirDrop the images to your iPhone');
  console.log('2. Use the Files app to copy to the app folder');
  console.log('3. Import from Photos using the app\'s Import button');
  console.log(`\nFixtures location: ${FIXTURES_DIR}`);
}

main().catch(console.error);
