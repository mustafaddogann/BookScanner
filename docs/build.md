# Build Troubleshooting Guide

This document covers common build issues and their fixes, with focus on iOS.

**Related Documentation:**
- [docs/project_plan.md](./project_plan.md) - Project roadmap and future gates
- [docs/pipeline.md](./pipeline.md) - Pipeline stage documentation
- [docs/gates.md](./gates.md) - Stop-the-line gate checklist

---

## iOS Build Failures

### 1. Vision Framework Handler Type Error

**Error:**
```
Use of undeclared identifier 'VNRecognizeTextRequestCompletionHandler'
```

**Cause:** `VNRecognizeTextRequestCompletionHandler` does not exist in the Vision framework. The correct type is `VNRequestCompletionHandler` or use an inline block.

**Fix:**
```objc
// WRONG - this type doesn't exist
VNRecognizeTextRequestCompletionHandler handler = ^(VNRequest *request, NSError *error) {
    // ...
};
VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:handler];

// CORRECT - use inline block
VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:^(VNRequest * _Nonnull request, NSError * _Nullable error) {
    // ...
}];
```

### 2. Non-Modular Include Errors

**Error:**
```
Include of non-modular header inside framework module
```

**Cause:** Using `#import <Framework/Framework.h>` instead of modular imports (`@import`).

**Fix for native modules:**
```objc
// WRONG
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <Vision/Vision.h>

// CORRECT - use @import for system frameworks
@import Foundation;
@import UIKit;
@import Vision;
@import CoreImage;

// React Native headers still use #import (they're special-cased)
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>
```

### 3. Podfile Hardening

Add these settings to `ios/Podfile` in the `post_install` block to prevent build issues:

```ruby
post_install do |installer|
  react_native_post_install(
    installer,
    config[:reactNativePath],
    :mac_catalyst_enabled => false,
  )

  # iOS build hardening: fix module issues and warnings
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      # Allow non-modular includes in framework modules (fixes RCT* import issues)
      config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'
      # Enable modules for C and Objective-C
      config.build_settings['CLANG_ENABLE_MODULES'] = 'YES'
      # Suppress deprecation warnings for older iOS APIs
      config.build_settings['GCC_WARN_ABOUT_DEPRECATED_FUNCTIONS'] = 'NO'
    end
  end
end
```

After modifying `Podfile`, run:
```bash
cd ios && pod install
```

### 4. Model Loading Failure on iOS

**Error:**
```
NSURLConnection finished with error - code -1002
The model is not a valid Flatbuffer buffer
```

**Cause:** iOS cannot load TFLite models via `asset://` URL. The native `TFLite.loadModel()` requires an absolute filesystem path on iOS.

**Fix:** Use the `ModelPathResolver` native module to get the bundle path:

```typescript
// In inferenceService.ts
import { Platform, NativeModules } from 'react-native';

async function resolveModelPath(): Promise<{ path: string; isAssetUri: boolean }> {
  if (Platform.OS === 'ios') {
    const { ModelPathResolver } = NativeModules;
    const absolutePath = await ModelPathResolver.getBundledModelPath('yolov8_obb.tflite');
    return { path: absolutePath, isAssetUri: false };
  } else {
    // Android: Use asset:// URI
    return { path: 'asset://models/yolov8_obb.tflite', isAssetUri: true };
  }
}
```

The model file must also be added to the Xcode project:
1. In Xcode, drag the `.tflite` file into the project navigator
2. Ensure it's checked for your app target
3. Verify it appears in "Copy Bundle Resources" build phase

## Build Commands

### Clean Build
```bash
# Clean and reinstall pods
cd ios
rm -rf Pods Podfile.lock build
pod install

# Or use the npx command
npx react-native clean
```

### Build from Command Line
```bash
# Debug build for simulator
xcodebuild -workspace BookScanner.xcworkspace \
  -scheme BookScanner \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  build

# Release build for device
xcodebuild -workspace BookScanner.xcworkspace \
  -scheme BookScanner \
  -configuration Release \
  -sdk iphoneos \
  build
```

### Run the App
```bash
# Using npx (recommended)
npx react-native run-ios

# Or with specific simulator
npx react-native run-ios --simulator="iPhone 17 Pro"
```

## Metro Development Server (Physical Device)

When running on a physical iOS device, the device must connect to Metro over the local network.

### Start Metro for LAN Access

```bash
# Start Metro bound to all network interfaces
npx react-native start --reset-cache --host 0.0.0.0 --port 8081
```

This makes Metro accessible from any device on your network at `http://<YOUR_MAC_IP>:8081`.

### Find Your Mac's IP Address

```bash
# macOS
ipconfig getifaddr en0

# Example output: 10.0.0.65
```

### Configure the iOS Device

1. **Ensure same Wi-Fi network**: Your iPhone and Mac must be on the same Wi-Fi network.

2. **Grant Local Network Permission**:
   - After adding `NSLocalNetworkUsageDescription` to Info.plist, you must **delete and reinstall** the app to re-trigger the permission prompt.
   - Tap "Allow" when prompted for local network access.

3. **Configure bundler host in app**:
   - Shake the device or press Cmd+D in simulator to open Dev Menu
   - Tap "Settings" → "Change Bundle Location"
   - Enter your Mac's LAN IP and port: `10.0.0.65:8081`

### Troubleshooting Metro Connection

**Error: NSURLErrorDomain Code=-1009 "Local network prohibited"**

This means the app doesn't have local network permission:
1. Delete the app from the device
2. Rebuild and reinstall: `npx react-native run-ios --device`
3. When prompted, tap "Allow" for local network access

**Error: Could not connect to development server**

1. Verify Metro is running with `--host 0.0.0.0`
2. Verify Mac's firewall allows incoming connections on port 8081
3. Verify iPhone and Mac are on the same Wi-Fi network
4. Try accessing `http://<MAC_IP>:8081/status` from Safari on the iPhone

### Info.plist Requirements

The following keys must be present in `ios/BookScanner/Info.plist`:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>BookScanner needs local network access to connect to the Metro development server for loading JavaScript bundles during development.</string>
<key>NSBonjourServices</key>
<array>
    <string>_http._tcp.</string>
    <string>_http-alt._tcp.</string>
</array>
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

## Native Module Files

The following native modules are located in `ios/`:

| File | Purpose |
|------|---------|
| `ImagePreprocessor.m` | Image decoding, letterboxing, tensor preparation, OBB overlay drawing |
| `TextRecognizer.m` | OCR using iOS Vision framework |
| `ModelPathResolver.m` | Resolves bundle paths for TFLite model loading |

All native modules should:
1. Use `@import` for system frameworks (Foundation, UIKit, Vision, CoreImage)
2. Use `#import` for React Native headers (RCTBridgeModule, RCTLog)
3. Export methods using `RCT_EXPORT_METHOD`
4. Handle errors properly with `reject:` callback

## Common Issues Checklist

- [ ] Did you run `pod install` after adding/modifying native modules?
- [ ] Are all system framework imports using `@import` syntax?
- [ ] Is the model file included in "Copy Bundle Resources"?
- [ ] Did you add Podfile hardening settings?
- [ ] Are there any syntax errors in Objective-C handlers?

---

## Platform Support Summary

| Feature | iOS | Android |
|---------|-----|---------|
| Camera capture | Yes | Yes |
| YOLOv8 OBB detection | Yes | Yes |
| SVG overlay | Yes | Yes |
| Rectification | Yes (CoreImage) | Not yet (returns `skipped`) |
| OCR | Yes (Vision) | Yes (ML Kit) |
| Results UI | Yes | Yes |

---

## Testing

### Run All Tests

```bash
# All tests (use --watchman=false to avoid watchman issues)
npx jest --watchman=false

# With coverage
npx jest --watchman=false --coverage

# Specific test file
npx jest src/services/__tests__/textRecognitionService.test.ts --watchman=false
```

### TypeScript Check

```bash
npx tsc --noEmit
```

### Lint

```bash
npx eslint src/
```

### Full Validation (before PR)

```bash
# Run all checks
npx tsc --noEmit && npx jest --watchman=false && npx eslint src/
```

---

## Environment Setup

### Prerequisites

- Node.js 18+
- Xcode 15+ (for iOS)
- Android Studio (for Android)
- CocoaPods (`gem install cocoapods`)

### Initial Setup

```bash
# Clone and install
git clone <repo-url>
cd BookScanner
npm install

# iOS pods
cd ios && pod install && cd ..

# Verify model file exists
ls -la src/models/yolov8_obb.tflite
```

### Development Server

```bash
# Start Metro
npx react-native start --reset-cache

# For physical device (LAN access)
npx react-native start --reset-cache --host 0.0.0.0 --port 8081
```

### Build and Run

```bash
# iOS simulator
npx react-native run-ios

# iOS device
npx react-native run-ios --device

# Android
npx react-native run-android
```
