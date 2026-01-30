# BookScanner Development & Testing Guide

**Definitive, step-by-step guide for development and testing on iOS.**

This guide removes ambiguity about when to use Metro, Simulator, Physical Device, Xcode, or CLI for each testing scenario.

---

## Table of Contents

1. [Quick Start (Day-to-day Dev)](#1-quick-start-day-to-day-dev)
2. [Release / No-Metro Runs](#2-release--no-metro-runs)
3. [Simulator vs Device: What to Use and Why](#3-simulator-vs-device-what-to-use-and-why)
4. [Pipeline Validation Checklist (Gate-by-gate)](#4-pipeline-validation-checklist-gate-by-gate)
5. [Feature Flags and Config](#5-feature-flags-and-config)
6. [Supabase End-to-End Verification](#6-supabase-end-to-end-verification)
7. [Troubleshooting (High-value)](#7-troubleshooting-high-value)
8. [Appendices](#8-appendices)

---

## 1. Quick Start (Day-to-day Dev)

### 1.1 Prerequisites

- **macOS** with Xcode 15+ installed
- **Node.js 20+** (`node --version`)
- **Ruby** for CocoaPods (`ruby --version`)
- **CocoaPods** (`pod --version`)
- **Watchman** (recommended): `brew install watchman`

### 1.2 Clean Install Steps

Run these commands from the project root (`BookScanner/`):

```bash
# 1. Install JS dependencies
npm install

# 2. Install iOS CocoaPods
cd ios && pod install && cd ..

# 3. Verify TypeScript compiles
npx tsc --noEmit

# 4. Run tests
npx jest --watchman=false
```

**STOP condition:** If any step fails, fix it before proceeding. Common issues:
- `pod install` fails → Run `pod repo update` first
- `tsc` errors → Check the specific TypeScript errors in the output
- Jest fails → Check which test file is failing

### 1.3 Start Metro (Debug)

Metro is the JavaScript bundler. **Required for Debug builds.**

```bash
# Terminal 1: Start Metro
npm start

# OR with cache reset (if seeing stale code)
npm start -- --reset-cache
```

**Metro is running when you see:**
```
▐▌ Metro waiting on http://localhost:8081
```

**STOP condition:** If Metro fails to start:
- Port 8081 in use → Kill the process: `lsof -ti:8081 | xargs kill -9`
- Node modules issue → `rm -rf node_modules && npm install`

### 1.4 Run on iOS Simulator

```bash
# In a new terminal (Metro must be running)
npm run ios
```

This will:
1. Build the app via `xcodebuild`
2. Install on the booted Simulator
3. Launch the app

**STOP condition:** Build fails → Open Xcode and check the build log for details.

### 1.5 Run on Physical iPhone

**Requirements:**
- iPhone connected via USB
- Developer Mode enabled on device (Settings → Privacy & Security → Developer Mode)
- Signing configured in Xcode (see 1.5.1)

#### 1.5.1 First-Time Xcode Signing Setup

```bash
open ios/BookScanner.xcworkspace
```

1. Select the **BookScanner** target (not Pods)
2. Go to **Signing & Capabilities** tab
3. Check "Automatically manage signing"
4. Select your **Team** (Apple ID or Developer account)
5. Xcode will create a provisioning profile

**STOP condition:** "No profiles for team" → Ensure your Apple ID is added in Xcode → Settings → Accounts.

#### 1.5.2 Run on Device via CLI

```bash
# Metro must be running
npm run ios -- --device "Your iPhone Name"

# List available devices
xcrun xctrace list devices
```

#### 1.5.3 Run on Device via Xcode

1. Open `ios/BookScanner.xcworkspace`
2. Select your iPhone from the device dropdown (top left)
3. Press **Cmd+R** or click the Play button
4. Trust the developer on device if prompted (Settings → General → VPN & Device Management)

---

## 2. Release / No-Metro Runs

### 2.1 Why Release Mode?

- **No Metro required** - JS is bundled into the app
- **Performance testing** - Production-like behavior
- **Pre-flight check** - Before App Store submission

### 2.2 Run Release on Device from Xcode

1. Open `ios/BookScanner.xcworkspace`
2. Select your physical device (Release doesn't work on Simulator for testing)
3. **Product → Scheme → Edit Scheme** (or Cmd+<)
4. Change **Build Configuration** from `Debug` to `Release`
5. Click **Close**
6. Press **Cmd+R** to build and run

**STOP Metro first!** Having Metro running can cause confusion.

**Verification:** The app should launch and function without Metro running. If it shows a red error screen, the bundle wasn't included.

### 2.3 Create an .ipa / Archive

```bash
# 1. Ensure you have a Release scheme
open ios/BookScanner.xcworkspace

# 2. In Xcode:
#    - Select "Any iOS Device (arm64)" as destination
#    - Product → Archive
#    - Wait for archive to complete
#    - Organizer window opens with the archive
```

From Organizer:
- **Distribute App** → Ad Hoc / App Store / Development
- **Export** to get an `.ipa` file

### 2.4 Verify App is Running Bundled JS

**Test:** After installing Release build:
1. Kill Metro if running
2. Turn off Mac's WiFi (device can't reach packager)
3. Launch app on device
4. **Expected:** App works normally
5. **Failure:** Red screen with "Unable to load script" or blank screen

**Check the bundle exists:**
```bash
# In the built app bundle
ls -la ios/build/Build/Products/Release-iphoneos/BookScanner.app/main.jsbundle
```

### 2.5 Common Release Pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| Red screen: "No bundle URL" | Bundle not created | Clean build: Product → Clean Build Folder, then Archive again |
| Blank white screen | JS error on startup | Run Debug first to see error, fix, then retry Release |
| App crashes immediately | Native module issue | Check Xcode console for crash log |
| "Unable to verify app" on device | Provisioning expired | Re-sign in Xcode, rebuild |

---

## 3. Simulator vs Device: What to Use and Why

### 3.1 Capability Comparison Table

| Feature | Simulator | Physical Device | Notes |
|---------|-----------|-----------------|-------|
| **Camera (VisionCamera)** | ❌ No | ✅ Yes | Simulator has no camera hardware |
| **TFLite Inference** | ⚠️ Slow | ✅ Fast | Simulator runs x86 translation, 10x slower |
| **CoreImage Rectification** | ✅ Yes | ✅ Yes | Both work, device is faster |
| **Vision OCR** | ✅ Yes | ✅ Yes | Identical behavior |
| **File system (RNFS)** | ✅ Yes | ✅ Yes | Paths differ but both work |
| **MMKV Storage** | ✅ Yes | ✅ Yes | Identical |
| **Network/Supabase** | ✅ Yes | ✅ Yes | Simulator uses Mac's network |
| **ModelPathResolver** | ✅ Yes | ✅ Yes | Both resolve bundle paths |
| **Performance profiling** | ❌ Unreliable | ✅ Accurate | Always profile on device |
| **Photo Library picker** | ✅ Yes | ✅ Yes | Both support image-picker |

### 3.2 When to Use What

| Testing Goal | Use |
|--------------|-----|
| UI layout and navigation | Simulator ✅ |
| TypeScript/JS logic debugging | Simulator ✅ |
| Quick iteration on OCR post-processing | Simulator ✅ (load from photo library) |
| Camera capture testing | **Device only** |
| Real-world book scanning | **Device only** |
| Performance benchmarking | **Device only** |
| Release build verification | **Device only** |
| Gate 7/8/9 pipeline with fixture images | Simulator ✅ |
| Supabase Edge Function calls | Either (Simulator ✅) |

### 3.3 Explicit Recommendation

**Tests that MUST be on a real iPhone:**
1. End-to-end camera capture → detection → OCR flow
2. Performance timing (inference, rectification)
3. Release/Archive builds
4. VisionCamera frame processor behavior
5. Memory usage under real load

**Tests fine on Simulator:**
1. UI components and navigation
2. Unit tests (`npm test`)
3. Fixture-based pipeline runs (loading saved images)
4. Supabase network calls
5. MMKV persistence
6. OCR with photo library images

---

## 4. Pipeline Validation Checklist (Gate-by-gate)

### 4.1 Overview

The BookScanner pipeline has these stages:
```
Capture → Inference → Rectification → OCR → Grouping (Gate 7) → Hypothesis (Gate 8) → Resolver (Gate 9)
```

### 4.2 Stage: Capture

**Preconditions:**
- Physical device (camera doesn't work on Simulator)
- Camera permission granted
- VisionCamera module linked

**How to trigger:**
1. Launch app
2. Camera preview appears automatically
3. Tap "Scan" button to capture frame

**Expected behavior:**
- Live camera preview visible
- "Scan" button responsive
- Console log: `[Pipeline] Starting pipeline...`

**STOP condition:**
- Black/blank camera preview → Check permissions in Settings
- "Camera device not found" error → VisionCamera not linked properly
- App crashes on camera screen → Check Xcode console

**Artifacts:**
- When `DEBUG_ARTIFACTS_ENABLED = true`: `originalImage.jpg` saved in session folder

### 4.3 Stage: Inference (TFLite)

**Preconditions:**
- `yolov8_obb.tflite` bundled in app (10.3 MB file in `ios/BookScanner/`)
- Image captured or loaded from fixture

**How to trigger:**
- Automatic after capture
- For fixtures: Use photo picker to load an image

**Expected logs:**
```
[Pipeline] Stage: INFERENCE
[InferenceService] Model loaded successfully
[InferenceService] Inference completed in XXms
[InferenceService] Found N detections
```

**Where to look in UI:**
- Results screen → Overlay tab shows detection polygons
- Detection count displayed

**STOP condition:**
- "Model file not found" → Check `ModelPathResolver` logs, verify `.tflite` is in Copy Bundle Resources
- Zero detections on known good image → Check model path, try re-bundling
- Crash during inference → Check TFLite delegate, memory issues

**Artifacts (when DEBUG enabled):**
- `debug_manifest.json` with detection data
- `detections_raw.json` with raw tensor output

### 4.4 Stage: Rectification

**Preconditions:**
- Detections exist from inference stage
- iOS (CoreImage) or Android (placeholder)

**How to trigger:**
- Automatic after inference

**Expected logs (iOS):**
```
[Rectifier] Native rectification: AVAILABLE (CoreImage)
[Rectifier] Rectifying N detections
[Rectifier] Saved crop to: /path/to/crop_0.jpg
```

**Where to look in UI:**
- Results screen → Crops tab shows rectified crop images
- Each crop should be upright, deskewed

**STOP condition:**
- "ImagePreprocessor native module not found" → Native module not linked
- Crops are rotated/skewed → Check OBB corner calculation
- "Rectification Unavailable" on Android → Expected (placeholder)

**Artifacts:**
- `crop_0.jpg`, `crop_1.jpg`, etc. in session folder

### 4.5 Stage: OCR

**Preconditions:**
- Rectified crops exist
- iOS Vision framework available

**How to trigger:**
- Automatic after rectification

**Expected logs:**
```
[TextRecognition] Processing N crops
[TextRecognition] Crop 0: best rotation=0°, confidence=0.XX
[TextRecognition] Recognized text: "Book Title Here"
```

**Where to look in UI:**
- Results screen → Crops tab
- Each crop shows recognized text below the image
- Tap crop to edit text

**STOP condition:**
- No text recognized on clear text → Check rotation trials logic
- Very low confidence scores → Check image quality, rectification
- OCR crashes → Check Vision framework availability

**Artifacts:**
- OCR results stored in `SessionMeta.ocrResultsByCropIndex`

### 4.6 Stage: Gate 7 - Book Candidate Grouping

**Preconditions:**
- OCR results exist
- Multiple detections (to test grouping)

**How to trigger:**
- Automatic after OCR

**Expected logs:**
```
[BookCandidateGrouper] Grouping N detections into candidates
[BookCandidateGrouper] Created M book candidates
```

**Where to look in UI:**
- Results screen → Books tab
- Shows grouped candidates (fewer than crops if merging occurred)

**STOP condition:**
- All detections merged into 1 candidate → Check conservative grouping thresholds
- Zero candidates → Check that detections exist

**Artifacts (when DEBUG enabled):**
- `grouping_assignments.json` with merge decisions

### 4.7 Stage: Gate 8 - Hypothesis Generation

**Preconditions:**
- Book candidates exist from Gate 7
- Feature flag check: `METADATA_RESOLUTION_ENABLED` controls whether hypothesis is used

**How to trigger:**
- Automatic after grouping

**Expected logs:**
```
[HypothesisGeneration] Generating hypotheses for M candidates
[HypothesisGeneration] Candidate 0: evidenceTier=strong, queries=2
```

**What to verify:**
- Each candidate has `hypothesis` object with:
  - `evidenceTier`: 'strong' | 'usable' | 'weak' | 'unusable'
  - `searchCandidates`: array of queries
  - `isbnCandidates`: array of validated ISBNs
  - `uiGuess`: { title, author, confidence }

**STOP condition:**
- All tiers are 'unusable' → Check OCR quality, evidence scoring
- No search candidates generated → Check search candidate service

### 4.8 Stage: Gate 9 - Supabase Resolver (Feature-Flagged)

**Preconditions:**
- `METADATA_RESOLUTION_ENABLED = true` in `src/config/debug.ts`
- Supabase configured in `src/config/supabase.ts`
- Edge function `resolve_candidates` deployed
- Device online

**How to trigger:**
- Automatic after hypothesis generation (when enabled)

**Expected logs:**
```
[MetadataResolution] Starting resolution for M candidates
[ResolverClient] Calling resolve_candidates edge function
[ResolverClient] Response: status=resolved, decision=auto-accept
```

**Where to look in UI:**
- Results screen → Books tab
- Resolved books show canonical metadata from Open Library
- "Resolved" badge or indicator

**STOP condition:**
- "Supabase not configured" warning → Check `src/config/supabase.ts`
- Rate limited response → Wait 1 minute, retry
- Network error → Check device connectivity

### 4.9 Stage: Offline Queue (Feature-Flagged)

**Preconditions:**
- `METADATA_OFFLINE_QUEUE_ENABLED = true`
- Device offline when scanning

**How to trigger:**
1. Enable offline queue flag
2. Enable airplane mode on device
3. Scan books
4. Disable airplane mode
5. Queue should auto-process

**Expected logs:**
```
[OfflineQueue] Enqueued candidate: book-1
[OfflineQueue] Network available, processing 1 items
[OfflineQueue] Resolved book-1
```

**STOP condition:**
- Queue never processes → Check NetInfo listener, app state handling

### 4.10 Stage: Gate 10 - Corrections Memory

**Preconditions:**
- Book candidates exist
- OCR results available for hashing
- MMKV storage available

**How to trigger:**
1. Scan a bookshelf
2. Go to Results → Books tab
3. Tap a book candidate
4. Tap "Edit" to open edit modal
5. Edit title/author
6. Tap "Save"
7. Scan the same bookshelf again
8. The correction should auto-apply

**Expected logs:**
```
[CorrectionsMemory] Saved correction for key hash:abc12345: title="Corrected Title", author="Corrected Author"
[Pipeline] Applying corrections to N candidates
[Corrections] Applied correction key=hash:abc12345, candidateId=book-1, matched=true
```

**Where to look in UI:**
- Results screen → Books tab
- "Auto" badge appears on candidates with auto-applied corrections
- "Edited" badge appears on manually edited candidates
- Edit modal shows "Revert to Auto-Detected" button when correction exists

**Verification steps:**
1. **Save correction test:**
   - Edit a book's title and save
   - Check console for `[CorrectionsMemory] Saved correction` log

2. **Auto-apply test:**
   - Scan the same book again
   - Verify "Auto" badge appears on the candidate
   - Verify the corrected title/author displays

3. **Revert test:**
   - Open edit modal for an auto-applied candidate
   - Tap "Revert to Auto-Detected"
   - Verify correction is removed
   - Verify original OCR values display

4. **Persistence test:**
   - Save a correction
   - Force-quit the app
   - Relaunch and scan the same book
   - Verify correction auto-applies

**STOP condition:**
- "No correction found" when re-scanning → Check content hash stability
- Corrections not persisting → Check MMKV storage initialization
- "Auto" badge not appearing → Check `appliedCorrection` field on candidate

**Artifacts:**
- Corrections stored in MMKV under key `corrections_memory`
- Max 500 corrections with LRU eviction

**Diagnostic logging:**
When `DEBUG_ARTIFACTS_ENABLED = true` or `METADATA_VERBOSE_DEBUG = true`:
- Logs correction key, matched status, title/author for each apply attempt
- Enable via `src/config/debug.ts`

---

## 5. Feature Flags and Config

### 5.1 Flag Locations

All feature flags are in:
```
src/config/debug.ts
```

### 5.2 Current Flags and Defaults

| Flag | Default | Purpose |
|------|---------|---------|
| `DEBUG_ARTIFACTS_ENABLED` | `false` | Write debug JSON/images to disk |
| `METADATA_LOOKUP_ENABLED` | `true` | Enable network metadata lookup |
| `METADATA_RESOLUTION_ENABLED` | `false` | Enable Gate 8+9 pipeline |
| `METADATA_AI_REFINEMENT_ENABLED` | `false` | Placeholder for LLM integration |
| `METADATA_OFFLINE_QUEUE_ENABLED` | `false` | Queue unresolved for retry |
| `METADATA_VERBOSE_DEBUG` | `false` | Extra logging for metadata |
| `METADATA_FIELD_EXTRACTION_ENABLED` | `false` | Enhanced field extraction |

### 5.3 How to Toggle Safely

1. Edit `src/config/debug.ts`
2. Change the flag value
3. Save the file
4. Metro hot-reloads automatically (Debug mode)
5. For Release builds, rebuild the app

**Example:**
```typescript
// To enable Gate 9 resolver:
export const METADATA_RESOLUTION_ENABLED = true;
```

### 5.4 Confirming a Flag is Active

**Method 1: Check logs**

Add temporary log in the flag check:
```typescript
export function isMetadataResolutionEnabled(): boolean {
  console.log('[DEBUG] METADATA_RESOLUTION_ENABLED =', METADATA_RESOLUTION_ENABLED);
  return METADATA_RESOLUTION_ENABLED;
}
```

**Method 2: UI markers**

When `DEBUG_ARTIFACTS_ENABLED = true`:
- Debug overlay shows on Results screen
- Session folder contains `debug_manifest.json`

When `METADATA_RESOLUTION_ENABLED = true`:
- Console shows `[MetadataResolution] Starting resolution...`
- Books tab shows resolved metadata

---

## 6. Supabase End-to-End Verification

### 6.1 Verify Migrations Applied

Check that tables exist in your Supabase project:

```bash
# Using Supabase CLI (if linked)
cd supabase
supabase db diff

# Or via SQL in Supabase Dashboard → SQL Editor:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('resolver_cache', 'user_corrections', 'resolver_events');
```

**Expected:** 3 rows returned.

**STOP condition:** Tables missing → Run migration:
```bash
supabase db push
```

### 6.2 Verify Edge Function Deployed

```bash
# List deployed functions
supabase functions list

# Check function exists
supabase functions list | grep resolve_candidates
```

**Expected:** `resolve_candidates` appears in list.

**Deploy if missing:**
```bash
supabase functions deploy resolve_candidates
```

### 6.3 Run Edge Function Locally

```bash
# Start local Supabase (optional, for local testing)
supabase start

# Serve functions locally
supabase functions serve resolve_candidates --no-verify-jwt
```

### 6.4 Curl Examples Against Deployed Function

Replace `YOUR_PROJECT_REF` and `YOUR_ANON_KEY` with actual values from `src/config/supabase.ts`.

**Minimal request:**
```bash
curl -X POST \
  'https://YOUR_PROJECT_REF.supabase.co/functions/v1/resolve_candidates' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -d '{
    "sessionId": "test-session",
    "candidateId": "test-candidate",
    "evidenceHash": "abc123",
    "evidenceTier": "strong",
    "queries": [
      {
        "query": "The Great Gatsby Fitzgerald",
        "confidence": 0.85,
        "source": "ocr",
        "titleHint": "The Great Gatsby",
        "authorHint": "F. Scott Fitzgerald"
      }
    ],
    "isbnCandidates": []
  }'
```

**Expected response shape:**
```json
{
  "status": "resolved",
  "cacheHit": false,
  "quotaRemaining": 29,
  "matches": [...],
  "acceptanceDecision": {
    "type": "auto-accept",
    "book": {
      "title": "The Great Gatsby",
      "authors": ["F. Scott Fitzgerald"],
      "isbn13": "9780743273565",
      ...
    },
    "confidence": 0.87,
    "reason": "High confidence match"
  },
  "canonicalBook": {...},
  "verificationFlags": [],
  "processingTimeMs": 234
}
```

**ISBN lookup example:**
```bash
curl -X POST \
  'https://YOUR_PROJECT_REF.supabase.co/functions/v1/resolve_candidates' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -d '{
    "sessionId": "test-session",
    "candidateId": "test-isbn",
    "evidenceHash": "def456",
    "evidenceTier": "strong",
    "queries": [],
    "isbnCandidates": [
      { "isbn": "9780743273565", "confidence": 0.95 }
    ]
  }'
```

### 6.5 Configure Supabase in the App

**File:** `src/config/supabase.ts`

```typescript
// Replace these with your Supabase project values
const SUPABASE_URL: string = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY: string = 'YOUR_ANON_KEY';
```

**Where to find these:**
1. Go to [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Settings → API
4. Copy "Project URL" and "anon public" key

**Verification:**
```typescript
import { isSupabaseConfigured } from './src/config/supabase';
console.log('Supabase configured:', isSupabaseConfigured()); // Should be true
```

---

## 7. Troubleshooting (High-value)

### 7.1 Metro Issues

| Problem | Solution |
|---------|----------|
| Port 8081 in use | `lsof -ti:8081 \| xargs kill -9` |
| "Unable to resolve module" | `npm start -- --reset-cache` |
| Metro crashes on start | `rm -rf node_modules/.cache && npm start` |
| Changes not reflecting | Reload app: Cmd+R in Simulator, shake device → Reload |

### 7.2 Pods/Build Failures

| Problem | Solution |
|---------|----------|
| `pod install` fails | `cd ios && pod repo update && pod install` |
| "framework not found" | Clean: `cd ios && rm -rf Pods Podfile.lock && pod install` |
| Xcode build fails | Product → Clean Build Folder (Cmd+Shift+K), rebuild |
| Signing issues | Xcode → Target → Signing, check Team and Bundle ID |
| "No such module" error | Ensure pods installed, check Derived Data |

**Nuclear clean:**
```bash
cd ios
rm -rf Pods Podfile.lock build DerivedData
pod install
cd ..
```

### 7.3 "Device Offline"

When Xcode says "device offline" or device doesn't appear:

1. Unplug and replug USB cable
2. Click "Trust" on device when prompted
3. Restart Xcode
4. Check Developer Mode is ON: Settings → Privacy & Security → Developer Mode
5. Try different USB port/cable
6. Restart device

### 7.4 Missing Native Module Symptoms

| Module | Symptom | Fix |
|--------|---------|-----|
| `ModelPathResolver` | "Model file not found" error | Check `ios/BookScanner/ModelPathResolver.m` exists and is in Compile Sources |
| `ImagePreprocessor` | "Native module not found" for rectification | Check `ios/ImagePreprocessor.m` exists and is linked |
| `VisionCamera` | Black camera preview | `cd ios && pod install`, check Info.plist permissions |
| `react-native-mmkv` | App crashes on storage access | Rebuild pods, check C++ compatibility |
| `react-native-fs` | File operations fail | Check RNFS pod installed |

### 7.5 Camera Permissions and Blank Preview

1. **Check Info.plist has camera permission:**
   ```xml
   <key>NSCameraUsageDescription</key>
   <string>BookScanner needs camera access to scan book spines</string>
   ```

2. **Reset permissions on Simulator:**
   - Device → Erase All Content and Settings

3. **Check device Settings:**
   - Settings → BookScanner → Camera: ON

4. **VisionCamera not initializing:**
   - Check `useCameraDevice` returns valid device
   - Log: `console.log('Camera device:', device)`

### 7.6 "Works on Debug but not Release" Checklist

- [ ] JS bundle is included in the app (main.jsbundle exists)
- [ ] No `console.log` crashes (strip them in production)
- [ ] No development-only code paths that crash
- [ ] All native modules linked for Release configuration
- [ ] No localhost URLs hardcoded (use production URLs)
- [ ] Code signing valid for Release
- [ ] Test on actual device, not Simulator

**Quick check:**
```bash
# Verify bundle exists in built app
find ios/build -name "main.jsbundle" 2>/dev/null
```

---

## 8. Appendices

### 8.1 Clean Everything Command Block

**Copy-paste this entire block to nuke all caches:**

```bash
# Stop Metro if running
lsof -ti:8081 | xargs kill -9 2>/dev/null || true

# Remove all caches
rm -rf node_modules
rm -rf ios/Pods
rm -rf ios/Podfile.lock
rm -rf ios/build
rm -rf ~/Library/Developer/Xcode/DerivedData/BookScanner-*
watchman watch-del-all 2>/dev/null || true
rm -rf $TMPDIR/metro-*
rm -rf $TMPDIR/haste-map-*

# Reinstall
npm install
cd ios && pod install && cd ..

echo "✅ Clean complete. Run 'npm start' to start Metro."
```

### 8.2 Full Test Run Command Block

**Canonical test run with exact ordering:**

```bash
# 1. TypeScript check
echo "=== TypeScript Check ==="
npx tsc --noEmit
if [ $? -ne 0 ]; then echo "❌ TypeScript failed"; exit 1; fi

# 2. Jest tests
echo "=== Jest Tests ==="
npx jest --watchman=false
if [ $? -ne 0 ]; then echo "❌ Tests failed"; exit 1; fi

# 3. Start Metro in background
echo "=== Starting Metro ==="
npm start &
METRO_PID=$!
sleep 5

# 4. Run on iOS Simulator
echo "=== Building for Simulator ==="
npm run ios

# Cleanup
echo "=== Stopping Metro ==="
kill $METRO_PID 2>/dev/null

echo "✅ Full test run complete"
```

### 8.3 Known-Good Commands Reference

| Task | Command |
|------|---------|
| Install dependencies | `npm install` |
| Install pods | `cd ios && pod install && cd ..` |
| Start Metro | `npm start` |
| Start Metro (clean) | `npm start -- --reset-cache` |
| Run on Simulator | `npm run ios` |
| Run on device | `npm run ios -- --device "iPhone Name"` |
| Run tests | `npx jest --watchman=false` |
| TypeScript check | `npx tsc --noEmit` |
| Open Xcode | `open ios/BookScanner.xcworkspace` |
| List devices | `xcrun xctrace list devices` |
| Kill Metro port | `lsof -ti:8081 \| xargs kill -9` |
| Deploy Supabase function | `supabase functions deploy resolve_candidates` |
| Apply Supabase migrations | `supabase db push` |

### 8.4 Decision Tree: Which Path to Use?

```
START: What are you testing?
│
├─► Unit tests / TypeScript logic
│   └─► Use: Jest (`npx jest --watchman=false`)
│       Metro: ❌ Not required
│       Device: ❌ Not required
│
├─► UI layout / navigation
│   └─► Use: iOS Simulator + Debug
│       Metro: ✅ Required
│       Device: ❌ Simulator is fine
│
├─► Camera capture / real scanning
│   └─► Use: Physical iPhone + Debug
│       Metro: ✅ Required
│       Device: ✅ Required (camera)
│
├─► Performance benchmarking
│   └─► Use: Physical iPhone + Release
│       Metro: ❌ Must be OFF
│       Device: ✅ Required (accurate timing)
│
├─► Supabase Edge Function
│   └─► Use: curl or Simulator + Debug
│       Metro: Optional (curl doesn't need app)
│       Device: ❌ Simulator is fine
│
├─► Pre-release verification
│   └─► Use: Physical iPhone + Release
│       Metro: ❌ Must be OFF
│       Device: ✅ Required
│
└─► Debugging a crash
    └─► Use: Xcode + Physical/Simulator + Debug
        Metro: ✅ Required
        Device: Depends on crash context
```

---

## Document Revision

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-26 | Claude | Initial creation |
| 2026-01-26 | Claude | Added Gate 10 Corrections Memory verification steps |
