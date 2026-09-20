#!/usr/bin/env node
/**
 * syncModel - copy the authoritative TFLite model into each platform's bundle location.
 *
 * SOURCE OF TRUTH: src/models/yolov8_obb.tflite (the only copy tracked in git).
 *
 * Before this script the repo carried four byte-identical 10.8 MB copies of the model
 * -- src/models/, ios/, ios/BookScanner/ and ml/runs/.../tflite_export/ -- all tracked,
 * and the README told you to drag the file into Xcode by hand. Nothing kept them in
 * sync, so an export could silently update one copy and leave the build using another.
 *
 * Destinations are gitignored and regenerated:
 *   ios/yolov8_obb.tflite
 *     Referenced by ios/BookScanner.xcodeproj as a Copy Bundle Resources entry. The
 *     "BookScanner" PBXGroup has no `path`, so its children resolve to ios/, not
 *     ios/BookScanner/. iOS loads it by absolute bundle path via ModelPathResolver.
 *   android/app/src/main/assets/models/yolov8_obb.tflite
 *     inferenceService resolves asset://models/yolov8_obb.tflite on Android. This was
 *     absent entirely, which is one of the reasons Android could not run the pipeline.
 *
 * Runs on `npm install` (postinstall) and before `npm run ios` / `npm run android`.
 * Copies only when the destination is missing or differs, so it is cheap to re-run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'src/models/yolov8_obb.tflite');

const DESTINATIONS = [
  path.join(ROOT, 'ios/yolov8_obb.tflite'),
  path.join(ROOT, 'android/app/src/main/assets/models/yolov8_obb.tflite'),
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    // Not fatal: a fresh checkout without the model should still be able to run
    // `npm install`, lint and tests. The build is what needs the file.
    console.warn(
      `[syncModel] Source model missing: ${path.relative(ROOT, SOURCE)}\n` +
        '[syncModel] Export it first: cd ml && ./scripts/export_tflite.sh'
    );
    return;
  }

  const sourceHash = sha256(SOURCE);
  const sizeMB = (fs.statSync(SOURCE).size / 1024 / 1024).toFixed(1);
  console.log(
    `[syncModel] Source ${path.relative(ROOT, SOURCE)} (${sizeMB} MB, sha256 ${sourceHash.slice(0, 12)})`
  );

  for (const dest of DESTINATIONS) {
    const rel = path.relative(ROOT, dest);
    if (fs.existsSync(dest) && sha256(dest) === sourceHash) {
      console.log(`[syncModel]   up to date: ${rel}`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(SOURCE, dest);
    console.log(`[syncModel]   copied -> ${rel}`);
  }
}

main();
