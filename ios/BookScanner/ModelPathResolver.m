/**
 * ModelPathResolver - Native module to resolve bundle file paths
 *
 * GATE 4 FIX: iOS cannot load TFLite models via asset:// URL.
 * This module returns absolute filesystem paths from the app bundle.
 */

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

@interface ModelPathResolver : NSObject <RCTBridgeModule>
@end

@implementation ModelPathResolver

RCT_EXPORT_MODULE();

/**
 * Get the absolute filesystem path for a bundled resource.
 * @param filename - The filename to look for (e.g., "yolov8_obb.tflite")
 * @param resolve - Promise resolve callback
 * @param reject - Promise reject callback
 */
RCT_EXPORT_METHOD(getBundledModelPath:(NSString *)filename
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  RCTLogInfo(@"[ModelPathResolver] Looking for bundled file: %@", filename);

  // Extract name and extension
  NSString *name = [filename stringByDeletingPathExtension];
  NSString *ext = [filename pathExtension];

  // Try main bundle first
  NSString *path = [[NSBundle mainBundle] pathForResource:name ofType:ext];

  if (path) {
    RCTLogInfo(@"[ModelPathResolver] Found in main bundle: %@", path);
    resolve(path);
    return;
  }

  // Try models subdirectory
  NSString *modelsName = [NSString stringWithFormat:@"models/%@", name];
  path = [[NSBundle mainBundle] pathForResource:modelsName ofType:ext];

  if (path) {
    RCTLogInfo(@"[ModelPathResolver] Found in models/: %@", path);
    resolve(path);
    return;
  }

  // Try without subdirectory but with full filename
  path = [[NSBundle mainBundle] pathForResource:filename ofType:nil];

  if (path) {
    RCTLogInfo(@"[ModelPathResolver] Found with full filename: %@", path);
    resolve(path);
    return;
  }

  // Log available bundle resources for debugging
  [self logBundleContents];

  // Reject with detailed error
  NSString *errorMsg = [NSString stringWithFormat:
    @"Model file not found in bundle: %@\n"
    @"Ensure it is added to Xcode project and included in 'Copy Bundle Resources'.\n"
    @"Searched: main bundle root, models/ subdirectory", filename];

  reject(@"MODEL_NOT_FOUND", errorMsg, nil);
}

/**
 * List all bundle resources (for debugging)
 */
RCT_EXPORT_METHOD(listBundleResources:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSMutableArray *resources = [NSMutableArray array];
  NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *error = nil;

  NSArray *contents = [fm contentsOfDirectoryAtPath:bundlePath error:&error];

  if (error) {
    reject(@"LIST_ERROR", error.localizedDescription, error);
    return;
  }

  for (NSString *item in contents) {
    NSString *fullPath = [bundlePath stringByAppendingPathComponent:item];
    NSDictionary *attrs = [fm attributesOfItemAtPath:fullPath error:nil];

    NSMutableDictionary *info = [NSMutableDictionary dictionary];
    info[@"name"] = item;
    info[@"isDirectory"] = @([attrs[NSFileType] isEqualToString:NSFileTypeDirectory]);
    info[@"size"] = attrs[NSFileSize] ?: @0;

    [resources addObject:info];

    // Log tflite files specifically
    if ([item.pathExtension isEqualToString:@"tflite"]) {
      RCTLogInfo(@"[ModelPathResolver] Found .tflite: %@ (size: %@)", item, attrs[NSFileSize]);
    }
  }

  resolve(resources);
}

/**
 * Check if a file exists and get its size
 */
RCT_EXPORT_METHOD(checkFileExists:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSFileManager *fm = [NSFileManager defaultManager];
  BOOL exists = [fm fileExistsAtPath:path];

  if (exists) {
    NSError *error = nil;
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:&error];

    if (error) {
      reject(@"STAT_ERROR", error.localizedDescription, error);
      return;
    }

    resolve(@{
      @"exists": @YES,
      @"size": attrs[NSFileSize] ?: @0,
      @"path": path
    });
  } else {
    resolve(@{
      @"exists": @NO,
      @"path": path
    });
  }
}

/**
 * Internal helper to log bundle contents
 */
- (void)logBundleContents
{
  NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *error = nil;

  RCTLogInfo(@"[ModelPathResolver] Bundle path: %@", bundlePath);

  NSArray *contents = [fm contentsOfDirectoryAtPath:bundlePath error:&error];

  if (error) {
    RCTLogInfo(@"[ModelPathResolver] Error listing bundle: %@", error.localizedDescription);
    return;
  }

  RCTLogInfo(@"[ModelPathResolver] Bundle contents (%lu items):", (unsigned long)contents.count);

  for (NSString *item in contents) {
    NSString *fullPath = [bundlePath stringByAppendingPathComponent:item];
    NSDictionary *attrs = [fm attributesOfItemAtPath:fullPath error:nil];
    NSString *type = [attrs[NSFileType] isEqualToString:NSFileTypeDirectory] ? @"DIR" : @"FILE";

    RCTLogInfo(@"  [%@] %@ (%@ bytes)", type, item, attrs[NSFileSize] ?: @"?");

    // Look inside directories for model files
    if ([attrs[NSFileType] isEqualToString:NSFileTypeDirectory]) {
      NSArray *subContents = [fm contentsOfDirectoryAtPath:fullPath error:nil];
      for (NSString *subItem in subContents) {
        if ([subItem.pathExtension isEqualToString:@"tflite"]) {
          NSString *subPath = [fullPath stringByAppendingPathComponent:subItem];
          NSDictionary *subAttrs = [fm attributesOfItemAtPath:subPath error:nil];
          RCTLogInfo(@"    [TFLITE] %@ (%@ bytes)", subItem, subAttrs[NSFileSize]);
        }
      }
    }
  }
}

@end
