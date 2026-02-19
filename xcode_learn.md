# Xcode Build Notes (Reuse for Future Projects)

## Why Builds Suddenly Become Very Slow

If you run aggressive cleanup commands like:

```bash
killall -9 xcodebuild xcbuild 2>/dev/null || true
rm -rf ~/Library/Developer/Xcode/DerivedData/<Project>-*/Build/Intermediates.noindex/XCBuildData
```

you force a **cold build**.

Cold build means Xcode must:

1. Recompute full build graph.
2. Rebuild many Pods/targets.
3. Recreate index datastore.
4. Re-sign and reinstall on device.

Result: build can become much slower than normal incremental builds.

## Build Types

1. Incremental build (fast):
   - Best case.
   - Uses cached build graph and previous outputs.
2. Cold build (slow):
   - Happens after deleting key DerivedData/XCBuildData content.
   - Also happens when many files/configs change.

## Practical Rule

Only do hard cleanup when build is broken.  
Do not use hard cleanup as default.

## Recommended Cleanup Levels

1. Soft clean (first choice):

```bash
xcodebuild -workspace ios/BookScanner.xcworkspace -scheme BookScanner -configuration Debug clean
```

2. Medium clean (if soft clean does not help):

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/BookScanner-*
```

3. Hard clean (last resort only):
   - Kill build processes + delete specific intermediate internals.

## Important: Automation Loop vs Manual Build

If background auto-fix/automation is running, it may modify files while you build.
That can invalidate incremental state and trigger extra rebuild work.

Pause automation before manual build, then restart after:

```bash
# stop running loop processes (adjust patterns as needed)
pkill -f "startAutomationLoop.js" 2>/dev/null || true
pkill -f "autoFixDaemon.js" 2>/dev/null || true
pkill -f "rejectsServer.js" 2>/dev/null || true
pkill -f "auto-fix.py" 2>/dev/null || true

# run manual build
npx react-native run-ios

# restart loop
npm run loop:start:codex
```

## Codex vs Claude Labels (Telegram/Watches)

The message label in Telegram comes from your watcher/bot profile, not from Xcode.
If the bot still says "Claude", that usually means the automation profile or script path is still pointing to Claude tooling.

Quick checks:

```bash
rg -n "claude|codex|auto-fix.py|loop:start" scripts package.json .claude .codex 2>/dev/null
```

Make sure active loop commands use the Codex profile/paths you expect.

## Missing auto-fix.py Error

If you see:

```text
Missing script: /Users/<you>/.claude/codex-bookscanner-loop/auto-fix.py
```

it means the watcher started, but the referenced script file does not exist at that absolute path.

Fix options:

1. Restore/copy `auto-fix.py` to that exact path.
2. Update the watcher config to the real script location.
3. Disable auto-fix loop temporarily while doing manual build/debug.

Verification:

```bash
ls -la /Users/<you>/.claude/codex-bookscanner-loop/auto-fix.py
```

## Build Speed Tips

1. Keep a single target device/destination stable.
2. Use Debug with `Build Active Architecture Only = Yes`.
3. Prefer `Debug Information Format = DWARF` in Debug builds.
4. Avoid unnecessary Pod reinstall/updates during routine iterations.
5. Avoid touching many generated/native config files between builds.

## How to Find Real Bottlenecks

Use timing summary:

```bash
xcodebuild \
  -workspace ios/BookScanner.xcworkspace \
  -scheme BookScanner \
  -configuration Debug \
  -destination "id=<DEVICE_ID>" \
  build \
  -showBuildTimingSummary
```

Look for:

1. Slowest targets (often Pods).
2. Repeated script phases.
3. Re-indexing spikes.

## Daily Fast Path

1. Keep automation paused during manual debugging/build.
2. Run normal incremental builds.
3. Only escalate to medium/hard clean when necessary.
4. Capture timing summary if a build regresses.

## Command Pitfall to Avoid

Use:

```bash
rm -rf ~/Library/Developer/Xcode/DerivedData/BookScanner-*/Build/Intermediates.noindex/XCBuildData
```

Avoid accidental variants like `XCBuildData(N)`; that typo may leave the real cache untouched and create confusing results.
