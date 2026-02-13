/**
 * ImagePreprocessor - Native module for image preprocessing
 *
 * Provides:
 * 1. Image decoding (JPEG/PNG to RGB bytes)
 * 2. Letterbox resizing with padding
 * 3. Float32 tensor generation for TFLite
 */

@import Foundation;
@import UIKit;
@import CoreImage;
@import Vision;
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

@interface TextRecognizer : NSObject
+ (UIImage *)rotateImage:(UIImage *)image byDegrees:(NSInteger)degrees;
+ (void)recognizeTextInImage:(UIImage *)image
            recognitionLevel:(NSString *)level
                   languages:(NSArray<NSString *> *)languages
                  completion:(void (^)(NSArray<NSDictionary *> *lines, NSError *error))completion
    API_AVAILABLE(ios(13.0));
+ (void)recognizeTextInCGImage:(CGImageRef)cgImage
              recognitionLevel:(NSString *)level
                     languages:(NSArray<NSString *> *)languages
                    completion:(void (^)(NSArray<NSDictionary *> *lines, NSError *error))completion
    API_AVAILABLE(ios(13.0));
+ (NSDictionary *)calculateMetricsForLines:(NSArray<NSDictionary *> *)lines;
+ (NSComparisonResult)compareMetricsA:(NSDictionary *)a withB:(NSDictionary *)b;
+ (NSDictionary *)extractTitleAuthorFromLines:(NSArray<NSDictionary *> *)lines;
@end

@interface ImagePreprocessor : NSObject <RCTBridgeModule>
@end

@implementation ImagePreprocessor

RCT_EXPORT_MODULE();

/**
 * Normalize UIImage to UIImageOrientationUp (apply EXIF rotation to actual pixels).
 * This ensures CGImage dimensions match the display orientation.
 */
+ (UIImage *)normalizeImageOrientation:(UIImage *)image {
  if (image.imageOrientation == UIImageOrientationUp) {
    return image; // Already correct orientation
  }

  // Get the correct output size (may be swapped for 90/270 rotations)
  CGSize outputSize = image.size; // UIImage.size already accounts for orientation

  // Create a new context with the corrected dimensions
  UIGraphicsBeginImageContextWithOptions(outputSize, NO, image.scale);
  [image drawInRect:CGRectMake(0, 0, outputSize.width, outputSize.height)];
  UIImage *normalizedImage = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  RCTLogInfo(@"[ImagePreprocessor] Normalized EXIF orientation %ld -> Up, size %.0fx%.0f",
             (long)image.imageOrientation, outputSize.width, outputSize.height);

  return normalizedImage ?: image; // Fallback to original if normalization fails
}

/**
 * Decode image file and return RGB pixel statistics (for debugging).
 * This proves the image was decoded correctly before any further processing.
 */
RCT_EXPORT_METHOD(getImageDecodeStats:(NSString *)imagePath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  RCTLogInfo(@"[ImagePreprocessor] Decoding image: %@", imagePath);

  // Clean path
  NSString *cleanPath = imagePath;
  if ([cleanPath hasPrefix:@"file://"]) {
    cleanPath = [cleanPath substringFromIndex:7];
  }

  // Load image
  UIImage *rawImage = [UIImage imageWithContentsOfFile:cleanPath];
  if (!rawImage) {
    reject(@"DECODE_FAILED", [NSString stringWithFormat:@"Failed to load image: %@", cleanPath], nil);
    return;
  }

  // CRITICAL: Normalize EXIF orientation BEFORE getting CGImage dimensions
  // This ensures width/height match the display orientation (consistent with preprocessForTFLite)
  UIImage *image = [ImagePreprocessor normalizeImageOrientation:rawImage];

  CGImageRef cgImage = image.CGImage;
  if (!cgImage) {
    reject(@"DECODE_FAILED", @"Failed to get CGImage", nil);
    return;
  }

  size_t width = CGImageGetWidth(cgImage);
  size_t height = CGImageGetHeight(cgImage);
  RCTLogInfo(@"[ImagePreprocessor] getImageDecodeStats: %zux%zu (raw orientation was %ld)",
             width, height, (long)rawImage.imageOrientation);
  size_t bytesPerPixel = 4; // RGBA
  size_t bytesPerRow = width * bytesPerPixel;
  size_t totalBytes = height * bytesPerRow;

  // Allocate buffer for RGBA pixels
  uint8_t *pixelData = (uint8_t *)calloc(totalBytes, 1);
  if (!pixelData) {
    reject(@"DECODE_FAILED", @"Failed to allocate pixel buffer", nil);
    return;
  }

  // Create context and draw image
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
    pixelData,
    width,
    height,
    8, // bits per component
    bytesPerRow,
    colorSpace,
    kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
  );

  if (!context) {
    free(pixelData);
    CGColorSpaceRelease(colorSpace);
    reject(@"DECODE_FAILED", @"Failed to create bitmap context", nil);
    return;
  }

  CGContextDrawImage(context, CGRectMake(0, 0, width, height), cgImage);

  // Compute stats (RGB channels only, skip alpha)
  uint64_t sumR = 0, sumG = 0, sumB = 0;
  uint8_t minR = 255, minG = 255, minB = 255;
  uint8_t maxR = 0, maxG = 0, maxB = 0;
  size_t pixelCount = width * height;

  for (size_t i = 0; i < pixelCount; i++) {
    uint8_t r = pixelData[i * 4];
    uint8_t g = pixelData[i * 4 + 1];
    uint8_t b = pixelData[i * 4 + 2];

    sumR += r; sumG += g; sumB += b;
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (g < minG) minG = g; if (g > maxG) maxG = g;
    if (b < minB) minB = b; if (b > maxB) maxB = b;
  }

  double meanR = (double)sumR / pixelCount;
  double meanG = (double)sumG / pixelCount;
  double meanB = (double)sumB / pixelCount;

  // Compute std
  double sqDiffSumR = 0, sqDiffSumG = 0, sqDiffSumB = 0;
  for (size_t i = 0; i < pixelCount; i++) {
    double r = pixelData[i * 4];
    double g = pixelData[i * 4 + 1];
    double b = pixelData[i * 4 + 2];
    sqDiffSumR += (r - meanR) * (r - meanR);
    sqDiffSumG += (g - meanG) * (g - meanG);
    sqDiffSumB += (b - meanB) * (b - meanB);
  }
  double stdR = sqrt(sqDiffSumR / pixelCount);
  double stdG = sqrt(sqDiffSumG / pixelCount);
  double stdB = sqrt(sqDiffSumB / pixelCount);

  // Cleanup
  CGContextRelease(context);
  CGColorSpaceRelease(colorSpace);
  free(pixelData);

  RCTLogInfo(@"[ImagePreprocessor] Decoded %zux%zu, RGB mean=[%.1f,%.1f,%.1f]", width, height, meanR, meanG, meanB);

  resolve(@{
    @"width": @(width),
    @"height": @(height),
    @"byteLength": @(totalBytes),
    @"pixelCount": @(pixelCount),
    @"channels": @{
      @"R": @{@"min": @(minR), @"max": @(maxR), @"mean": @(meanR), @"std": @(stdR)},
      @"G": @{@"min": @(minG), @"max": @(maxG), @"mean": @(meanG), @"std": @(stdG)},
      @"B": @{@"min": @(minB), @"max": @(maxB), @"mean": @(meanB), @"std": @(stdB)}
    },
    @"globalMin": @(MIN(MIN(minR, minG), minB)),
    @"globalMax": @(MAX(MAX(maxR, maxG), maxB)),
    @"path": cleanPath
  });
}

/**
 * Preprocess image for TFLite: decode, resize with letterbox, return float32 RGB as base64.
 *
 * @param imagePath - Path to source image (JPEG/PNG)
 * @param targetSize - Target size (640 for YOLOv8)
 * @param paddingValue - Padding fill value 0-255 (114 = gray)
 * @param resolve - Returns { tensorBase64, tensorShape, letterbox, stats }
 */
RCT_EXPORT_METHOD(preprocessForTFLite:(NSString *)imagePath
                  targetSize:(int)targetSize
                  paddingValue:(int)paddingValue
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  RCTLogInfo(@"[ImagePreprocessor] Preprocessing: %@, target=%d, padding=%d", imagePath, targetSize, paddingValue);

  // Clean path
  NSString *cleanPath = imagePath;
  if ([cleanPath hasPrefix:@"file://"]) {
    cleanPath = [cleanPath substringFromIndex:7];
  }

  // Load image
  UIImage *rawImage = [UIImage imageWithContentsOfFile:cleanPath];
  if (!rawImage) {
    reject(@"PREPROCESS_FAILED", [NSString stringWithFormat:@"Failed to load image: %@", cleanPath], nil);
    return;
  }

  // CRITICAL: Normalize EXIF orientation BEFORE getting CGImage dimensions
  // This ensures srcWidth/srcHeight match the display orientation
  UIImage *image = [ImagePreprocessor normalizeImageOrientation:rawImage];

  CGImageRef cgImage = image.CGImage;
  if (!cgImage) {
    reject(@"PREPROCESS_FAILED", @"Failed to get CGImage", nil);
    return;
  }

  size_t srcWidth = CGImageGetWidth(cgImage);
  size_t srcHeight = CGImageGetHeight(cgImage);
  RCTLogInfo(@"[ImagePreprocessor] After EXIF normalization: %zux%zu (raw was orientation %ld)",
             srcWidth, srcHeight, (long)rawImage.imageOrientation);

  // Calculate letterbox params
  float scale = MIN((float)targetSize / srcWidth, (float)targetSize / srcHeight);
  int newWidth = (int)roundf(srcWidth * scale);
  int newHeight = (int)roundf(srcHeight * scale);
  int padX = (targetSize - newWidth) / 2;
  int padY = (targetSize - newHeight) / 2;

  RCTLogInfo(@"[ImagePreprocessor] Letterbox: src=%zux%zu, scale=%.4f, new=%dx%d, pad=(%d,%d)",
             srcWidth, srcHeight, scale, newWidth, newHeight, padX, padY);

  // Allocate target buffer (RGBA for CGContext, will extract RGB)
  size_t targetBytesPerRow = targetSize * 4;
  size_t targetTotalBytes = targetSize * targetBytesPerRow;
  uint8_t *targetPixels = (uint8_t *)malloc(targetTotalBytes);
  if (!targetPixels) {
    reject(@"PREPROCESS_FAILED", @"Failed to allocate target buffer", nil);
    return;
  }

  // Fill with padding color (gray = 114)
  uint8_t padR = paddingValue, padG = paddingValue, padB = paddingValue, padA = 255;
  for (size_t i = 0; i < targetSize * targetSize; i++) {
    targetPixels[i * 4] = padR;
    targetPixels[i * 4 + 1] = padG;
    targetPixels[i * 4 + 2] = padB;
    targetPixels[i * 4 + 3] = padA;
  }

  // Create context
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
    targetPixels,
    targetSize,
    targetSize,
    8,
    targetBytesPerRow,
    colorSpace,
    kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
  );

  if (!context) {
    free(targetPixels);
    CGColorSpaceRelease(colorSpace);
    reject(@"PREPROCESS_FAILED", @"Failed to create target context", nil);
    return;
  }

  // Draw resized image centered in target
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(padX, padY, newWidth, newHeight), cgImage);

  // Convert RGBA uint8 to RGB float32 [0,1]
  size_t tensorSize = targetSize * targetSize * 3;
  float *tensorData = (float *)malloc(tensorSize * sizeof(float));
  if (!tensorData) {
    CGContextRelease(context);
    CGColorSpaceRelease(colorSpace);
    free(targetPixels);
    reject(@"PREPROCESS_FAILED", @"Failed to allocate tensor buffer", nil);
    return;
  }

  // NHWC format: [H, W, C] - interleaved RGB
  for (int i = 0; i < targetSize * targetSize; i++) {
    tensorData[i * 3] = targetPixels[i * 4] / 255.0f;       // R
    tensorData[i * 3 + 1] = targetPixels[i * 4 + 1] / 255.0f; // G
    tensorData[i * 3 + 2] = targetPixels[i * 4 + 2] / 255.0f; // B
  }

  // Compute tensor stats for verification
  float tMin = 1.0f, tMax = 0.0f, tSum = 0.0f;
  for (size_t i = 0; i < tensorSize; i++) {
    float v = tensorData[i];
    if (v < tMin) tMin = v;
    if (v > tMax) tMax = v;
    tSum += v;
  }
  float tMean = tSum / tensorSize;

  float tSqDiffSum = 0.0f;
  for (size_t i = 0; i < tensorSize; i++) {
    float diff = tensorData[i] - tMean;
    tSqDiffSum += diff * diff;
  }
  float tStd = sqrtf(tSqDiffSum / tensorSize);

  RCTLogInfo(@"[ImagePreprocessor] Tensor stats: min=%.4f, max=%.4f, mean=%.4f, std=%.4f",
             tMin, tMax, tMean, tStd);

  // Encode tensor as base64
  NSData *tensorNSData = [NSData dataWithBytes:tensorData length:tensorSize * sizeof(float)];
  NSString *tensorBase64 = [tensorNSData base64EncodedStringWithOptions:0];

  // Also create uint8 preview (for letterbox_640_preview.jpg)
  // This is the image BEFORE float normalization
  NSData *previewData = [NSData dataWithBytes:targetPixels length:targetTotalBytes];
  NSString *previewBase64RGBA = [previewData base64EncodedStringWithOptions:0];

  // Cleanup
  CGContextRelease(context);
  CGColorSpaceRelease(colorSpace);
  free(targetPixels);
  free(tensorData);

  resolve(@{
    @"tensorBase64": tensorBase64,
    @"tensorByteLength": @(tensorSize * sizeof(float)),
    @"tensorShape": @[@1, @(targetSize), @(targetSize), @3],
    @"tensorFormat": @"NHWC",
    // NATIVE TRUTH: These are the exact values used for letterboxing
    // JS must use these values directly, not recompute them
    @"nativeTruth": @{
      @"decodedW": @(srcWidth),      // Actual decoded pixel width
      @"decodedH": @(srcHeight),     // Actual decoded pixel height
      @"modelSize": @(targetSize),   // Model input size (640)
      @"scale": @(scale),            // Scale factor used
      @"newW": @(newWidth),          // Scaled width before padding
      @"newH": @(newHeight),         // Scaled height before padding
      @"padX": @(padX),              // Left padding
      @"padY": @(padY),              // Top padding
    },
    // Legacy letterbox format (for backward compatibility)
    @"letterbox": @{
      @"srcWidth": @(srcWidth),
      @"srcHeight": @(srcHeight),
      @"dstWidth": @(targetSize),
      @"dstHeight": @(targetSize),
      @"scale": @(scale),
      @"padX": @(padX),
      @"padY": @(padY)
    },
    @"tensorStats": @{
      @"min": @(tMin),
      @"max": @(tMax),
      @"mean": @(tMean),
      @"std": @(tStd),
      @"totalElements": @(tensorSize)
    },
    @"previewBase64RGBA": previewBase64RGBA,
    @"paddingValue": @(paddingValue),
    @"paddingValueNormalized": @(paddingValue / 255.0f)
  });
}

/**
 * Save uint8 preview image to file (for debugging artifacts).
 * Takes RGBA base64 from preprocessForTFLite and saves as JPEG.
 */
RCT_EXPORT_METHOD(savePreviewImage:(NSString *)rgbaBase64
                  width:(int)width
                  height:(int)height
                  outputPath:(NSString *)outputPath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // Decode base64
  NSData *rgbaData = [[NSData alloc] initWithBase64EncodedString:rgbaBase64 options:0];
  if (!rgbaData || rgbaData.length != width * height * 4) {
    reject(@"SAVE_FAILED", @"Invalid RGBA data", nil);
    return;
  }

  // Create CGImage from RGBA data
  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGDataProviderRef provider = CGDataProviderCreateWithCFData((__bridge CFDataRef)rgbaData);

  CGImageRef cgImage = CGImageCreate(
    width, height,
    8, 32, width * 4,
    colorSpace,
    kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big,
    provider,
    NULL, false,
    kCGRenderingIntentDefault
  );

  CGDataProviderRelease(provider);
  CGColorSpaceRelease(colorSpace);

  if (!cgImage) {
    reject(@"SAVE_FAILED", @"Failed to create CGImage", nil);
    return;
  }

  // Convert to UIImage and save as JPEG
  UIImage *uiImage = [UIImage imageWithCGImage:cgImage];
  CGImageRelease(cgImage);

  NSData *jpegData = UIImageJPEGRepresentation(uiImage, 0.95);
  if (!jpegData) {
    reject(@"SAVE_FAILED", @"Failed to create JPEG data", nil);
    return;
  }

  // Clean output path
  NSString *cleanPath = outputPath;
  if ([cleanPath hasPrefix:@"file://"]) {
    cleanPath = [cleanPath substringFromIndex:7];
  }

  NSError *error = nil;
  BOOL success = [jpegData writeToFile:cleanPath options:NSDataWritingAtomic error:&error];

  if (!success) {
    reject(@"SAVE_FAILED", error.localizedDescription, error);
    return;
  }

  RCTLogInfo(@"[ImagePreprocessor] Saved preview: %@ (%lu bytes)", cleanPath, (unsigned long)jpegData.length);

  resolve(@{
    @"path": cleanPath,
    @"size": @(jpegData.length)
  });
}

/**
 * Draw OBB boxes on an image and save the result.
 * Used for model-space overlay visualization.
 *
 * @param sourceImagePath - Path to source image (letterbox_640_preview.jpg)
 * @param detections - Array of OBB detections: {cx, cy, width, height, angle, score}
 * @param outputPath - Path to save the overlay image
 * @param lineWidth - Line width for drawing (default 2)
 */
RCT_EXPORT_METHOD(drawOBBOverlay:(NSString *)sourceImagePath
                  detections:(NSArray *)detections
                  outputPath:(NSString *)outputPath
                  lineWidth:(float)lineWidth
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  RCTLogInfo(@"[ImagePreprocessor] Drawing %lu OBBs on %@", (unsigned long)detections.count, sourceImagePath);

  // Clean source path
  NSString *cleanSourcePath = sourceImagePath;
  if ([cleanSourcePath hasPrefix:@"file://"]) {
    cleanSourcePath = [cleanSourcePath substringFromIndex:7];
  }

  // Load source image
  UIImage *sourceImage = [UIImage imageWithContentsOfFile:cleanSourcePath];
  if (!sourceImage) {
    reject(@"OVERLAY_FAILED", [NSString stringWithFormat:@"Failed to load source image: %@", cleanSourcePath], nil);
    return;
  }

  CGSize imageSize = sourceImage.size;
  CGFloat scale = sourceImage.scale;

  // Create graphics context
  UIGraphicsBeginImageContextWithOptions(imageSize, NO, scale);
  CGContextRef context = UIGraphicsGetCurrentContext();

  if (!context) {
    UIGraphicsEndImageContext();
    reject(@"OVERLAY_FAILED", @"Failed to create graphics context", nil);
    return;
  }

  // Draw the source image
  [sourceImage drawAtPoint:CGPointZero];

  // Set up drawing style
  if (lineWidth <= 0) lineWidth = 2.0f;

  // Draw each OBB detection
  for (NSDictionary *det in detections) {
    CGFloat cx = [det[@"cx"] floatValue];
    CGFloat cy = [det[@"cy"] floatValue];
    CGFloat width = [det[@"width"] floatValue];
    CGFloat height = [det[@"height"] floatValue];
    CGFloat angle = [det[@"angle"] floatValue];  // radians
    CGFloat score = [det[@"score"] floatValue];

    // Color based on score: green for high, yellow for medium, red for low
    UIColor *boxColor;
    if (score >= 0.8) {
      boxColor = [UIColor colorWithRed:0.0 green:1.0 blue:0.0 alpha:0.9];  // Green
    } else if (score >= 0.5) {
      boxColor = [UIColor colorWithRed:1.0 green:1.0 blue:0.0 alpha:0.9];  // Yellow
    } else {
      boxColor = [UIColor colorWithRed:1.0 green:0.3 blue:0.0 alpha:0.8];  // Orange-red
    }

    CGContextSetStrokeColorWithColor(context, boxColor.CGColor);
    CGContextSetLineWidth(context, lineWidth);

    // Save context state
    CGContextSaveGState(context);

    // Translate to center, rotate, then draw rect centered at origin
    CGContextTranslateCTM(context, cx, cy);
    CGContextRotateCTM(context, angle);

    // Draw rectangle centered at origin
    CGRect rect = CGRectMake(-width/2, -height/2, width, height);
    CGContextStrokeRect(context, rect);

    // Draw score text (rotated with box)
    NSString *scoreText = [NSString stringWithFormat:@"%.2f", score];
    NSDictionary *textAttrs = @{
      NSFontAttributeName: [UIFont boldSystemFontOfSize:10],
      NSForegroundColorAttributeName: boxColor
    };
    CGPoint textPoint = CGPointMake(-width/2, -height/2 - 12);
    [scoreText drawAtPoint:textPoint withAttributes:textAttrs];

    // Restore context state
    CGContextRestoreGState(context);
  }

  // Get the resulting image
  UIImage *overlayImage = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  if (!overlayImage) {
    reject(@"OVERLAY_FAILED", @"Failed to create overlay image", nil);
    return;
  }

  // Save as JPEG
  NSData *jpegData = UIImageJPEGRepresentation(overlayImage, 0.95);
  if (!jpegData) {
    reject(@"OVERLAY_FAILED", @"Failed to create JPEG data", nil);
    return;
  }

  // Clean output path
  NSString *cleanOutputPath = outputPath;
  if ([cleanOutputPath hasPrefix:@"file://"]) {
    cleanOutputPath = [cleanOutputPath substringFromIndex:7];
  }

  NSError *error = nil;
  BOOL success = [jpegData writeToFile:cleanOutputPath options:NSDataWritingAtomic error:&error];

  if (!success) {
    reject(@"OVERLAY_FAILED", error.localizedDescription, error);
    return;
  }

  RCTLogInfo(@"[ImagePreprocessor] Saved OBB overlay: %@ (%lu boxes, %lu bytes)",
             cleanOutputPath, (unsigned long)detections.count, (unsigned long)jpegData.length);

  resolve(@{
    @"path": cleanOutputPath,
    @"size": @(jpegData.length),
    @"numBoxes": @(detections.count)
  });
}

/**
 * Draw AABB (axis-aligned bounding box) overlays on an image.
 * Simpler than OBB - just draws rectangles without rotation.
 *
 * @param basePath - Path to base image (letterbox_640_preview.jpg)
 * @param boxes - Array of boxes: {x1, y1, x2, y2, score} in 0..640 coordinates
 * @param outPath - Path to save the overlay image
 */
RCT_EXPORT_METHOD(drawAABBOverlay:(NSString *)basePath
                  boxes:(NSArray *)boxes
                  outPath:(NSString *)outPath
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  RCTLogInfo(@"[ImagePreprocessor] Drawing %lu AABBs on %@", (unsigned long)boxes.count, basePath);

  // Clean base path
  NSString *cleanBasePath = basePath;
  if ([cleanBasePath hasPrefix:@"file://"]) {
    cleanBasePath = [cleanBasePath substringFromIndex:7];
  }

  // Load base image
  UIImage *baseImage = [UIImage imageWithContentsOfFile:cleanBasePath];
  if (!baseImage) {
    reject(@"AABB_OVERLAY_FAILED", [NSString stringWithFormat:@"Failed to load base image: %@", cleanBasePath], nil);
    return;
  }

  CGSize imageSize = baseImage.size;
  CGFloat scale = baseImage.scale;

  RCTLogInfo(@"[ImagePreprocessor] Base image size: %.0fx%.0f", imageSize.width, imageSize.height);

  // Create graphics context
  UIGraphicsBeginImageContextWithOptions(imageSize, NO, scale);
  CGContextRef context = UIGraphicsGetCurrentContext();

  if (!context) {
    UIGraphicsEndImageContext();
    reject(@"AABB_OVERLAY_FAILED", @"Failed to create graphics context", nil);
    return;
  }

  // Draw the base image
  [baseImage drawAtPoint:CGPointZero];

  // Set line width
  CGFloat lineWidth = 2.0f;
  CGContextSetLineWidth(context, lineWidth);

  // Draw each AABB box
  for (NSDictionary *box in boxes) {
    CGFloat x1 = [box[@"x1"] floatValue];
    CGFloat y1 = [box[@"y1"] floatValue];
    CGFloat x2 = [box[@"x2"] floatValue];
    CGFloat y2 = [box[@"y2"] floatValue];
    CGFloat score = [box[@"score"] floatValue];

    // Clamp to image bounds
    x1 = MAX(0, MIN(x1, imageSize.width));
    y1 = MAX(0, MIN(y1, imageSize.height));
    x2 = MAX(0, MIN(x2, imageSize.width));
    y2 = MAX(0, MIN(y2, imageSize.height));

    // Color based on score: green for high, yellow for medium, red for low
    UIColor *boxColor;
    if (score >= 0.8) {
      boxColor = [UIColor colorWithRed:0.0 green:1.0 blue:0.0 alpha:0.9];  // Green
    } else if (score >= 0.5) {
      boxColor = [UIColor colorWithRed:1.0 green:1.0 blue:0.0 alpha:0.9];  // Yellow
    } else {
      boxColor = [UIColor colorWithRed:1.0 green:0.3 blue:0.0 alpha:0.8];  // Orange-red
    }

    CGContextSetStrokeColorWithColor(context, boxColor.CGColor);

    // Draw rectangle
    CGRect rect = CGRectMake(x1, y1, x2 - x1, y2 - y1);
    CGContextStrokeRect(context, rect);

    // Draw score text above box
    NSString *scoreText = [NSString stringWithFormat:@"%.2f", score];
    NSDictionary *textAttrs = @{
      NSFontAttributeName: [UIFont boldSystemFontOfSize:9],
      NSForegroundColorAttributeName: boxColor
    };
    CGPoint textPoint = CGPointMake(x1, MAX(0, y1 - 11));
    [scoreText drawAtPoint:textPoint withAttributes:textAttrs];
  }

  // Get the resulting image
  UIImage *overlayImage = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  if (!overlayImage) {
    reject(@"AABB_OVERLAY_FAILED", @"Failed to create overlay image", nil);
    return;
  }

  // Save as JPEG
  NSData *jpegData = UIImageJPEGRepresentation(overlayImage, 0.95);
  if (!jpegData) {
    reject(@"AABB_OVERLAY_FAILED", @"Failed to create JPEG data", nil);
    return;
  }

  // Clean output path
  NSString *cleanOutPath = outPath;
  if ([cleanOutPath hasPrefix:@"file://"]) {
    cleanOutPath = [cleanOutPath substringFromIndex:7];
  }

  NSError *error = nil;
  BOOL success = [jpegData writeToFile:cleanOutPath options:NSDataWritingAtomic error:&error];

  if (!success) {
    reject(@"AABB_OVERLAY_FAILED", error.localizedDescription, error);
    return;
  }

  RCTLogInfo(@"[ImagePreprocessor] Saved AABB overlay: %@ (%lu boxes, %lu bytes)",
             cleanOutPath, (unsigned long)boxes.count, (unsigned long)jpegData.length);

  resolve(@{
    @"path": cleanOutPath,
    @"size": @(jpegData.length),
    @"numBoxes": @(boxes.count)
  });
}

// ============================================================================
// PERSPECTIVE RECTIFICATION using CoreImage
// ============================================================================

/**
 * Rectify a quadrilateral region of an image to an upright rectangle.
 * Uses CoreImage CIPerspectiveCorrection filter for high-quality warping.
 *
 * @param imagePath - Path to source image (file:// URI or absolute path)
 * @param corners - Dict with topLeft, topRight, bottomRight, bottomLeft (each has x, y in ORIGINAL IMAGE PIXELS)
 *                  NOTE: Corners must be in CLOCKWISE order starting from top-left
 * @param outputPath - Path where rectified crop should be saved
 * @param targetHeight - Target height for output (width computed from aspect ratio)
 *
 * Returns: {path, width, height, method: 'native_coreimage'}
 *
 * COORDINATE SYSTEM NOTE:
 * - Input corners are in UIKit coordinates (origin top-left, Y increases downward)
 * - CoreImage uses Cartesian coordinates (origin bottom-left, Y increases upward)
 * - This method handles the conversion internally
 */
RCT_EXPORT_METHOD(rectifyPerspective:(NSString *)imagePath
                  corners:(NSDictionary *)corners
                  outputPath:(NSString *)outputPath
                  targetHeight:(NSNumber *)targetHeight
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  RCTLogInfo(@"[ImagePreprocessor] rectifyPerspective called");
  RCTLogInfo(@"[ImagePreprocessor]   imagePath: %@", imagePath);
  RCTLogInfo(@"[ImagePreprocessor]   outputPath: %@", outputPath);
  RCTLogInfo(@"[ImagePreprocessor]   targetHeight: %@", targetHeight);

  // Clean paths
  NSString *cleanInputPath = imagePath;
  if ([cleanInputPath hasPrefix:@"file://"]) {
    cleanInputPath = [cleanInputPath substringFromIndex:7];
  }

  NSString *cleanOutputPath = outputPath;
  if ([cleanOutputPath hasPrefix:@"file://"]) {
    cleanOutputPath = [cleanOutputPath substringFromIndex:7];
  }

  // Parse corners
  NSDictionary *tlDict = corners[@"topLeft"];
  NSDictionary *trDict = corners[@"topRight"];
  NSDictionary *brDict = corners[@"bottomRight"];
  NSDictionary *blDict = corners[@"bottomLeft"];

  if (!tlDict || !trDict || !brDict || !blDict) {
    reject(@"RECTIFY_FAILED", @"Missing corner coordinates (need topLeft, topRight, bottomRight, bottomLeft)", nil);
    return;
  }

  CGFloat tlX = [tlDict[@"x"] floatValue];
  CGFloat tlY = [tlDict[@"y"] floatValue];
  CGFloat trX = [trDict[@"x"] floatValue];
  CGFloat trY = [trDict[@"y"] floatValue];
  CGFloat brX = [brDict[@"x"] floatValue];
  CGFloat brY = [brDict[@"y"] floatValue];
  CGFloat blX = [blDict[@"x"] floatValue];
  CGFloat blY = [blDict[@"y"] floatValue];

  RCTLogInfo(@"[ImagePreprocessor] Corners (UIKit coords):");
  RCTLogInfo(@"[ImagePreprocessor]   TL: (%.1f, %.1f)", tlX, tlY);
  RCTLogInfo(@"[ImagePreprocessor]   TR: (%.1f, %.1f)", trX, trY);
  RCTLogInfo(@"[ImagePreprocessor]   BR: (%.1f, %.1f)", brX, brY);
  RCTLogInfo(@"[ImagePreprocessor]   BL: (%.1f, %.1f)", blX, blY);

  // Load source image
  UIImage *rawImage = [UIImage imageWithContentsOfFile:cleanInputPath];
  if (!rawImage) {
    reject(@"RECTIFY_FAILED", [NSString stringWithFormat:@"Failed to load image: %@", cleanInputPath], nil);
    return;
  }

  // CRITICAL: Normalize EXIF orientation to get correct dimensions
  UIImage *image = [ImagePreprocessor normalizeImageOrientation:rawImage];
  CGFloat imageHeight = image.size.height;

  RCTLogInfo(@"[ImagePreprocessor] Image size after EXIF normalization: %.0fx%.0f", image.size.width, image.size.height);

  // Create CIImage from UIImage
  CIImage *ciImage = [[CIImage alloc] initWithImage:image];
  if (!ciImage) {
    reject(@"RECTIFY_FAILED", @"Failed to create CIImage", nil);
    return;
  }

  // Convert from UIKit coordinates (origin top-left) to CoreImage coordinates (origin bottom-left)
  // In CoreImage: y' = imageHeight - y
  CGFloat ciTlY = imageHeight - tlY;
  CGFloat ciTrY = imageHeight - trY;
  CGFloat ciBrY = imageHeight - brY;
  CGFloat ciBlY = imageHeight - blY;

  RCTLogInfo(@"[ImagePreprocessor] Corners (CoreImage coords):");
  RCTLogInfo(@"[ImagePreprocessor]   TL: (%.1f, %.1f)", tlX, ciTlY);
  RCTLogInfo(@"[ImagePreprocessor]   TR: (%.1f, %.1f)", trX, ciTrY);
  RCTLogInfo(@"[ImagePreprocessor]   BR: (%.1f, %.1f)", brX, ciBrY);
  RCTLogInfo(@"[ImagePreprocessor]   BL: (%.1f, %.1f)", blX, ciBlY);

  // Create CIVectors for the corner points
  // CIPerspectiveCorrection expects: topLeft, topRight, bottomRight, bottomLeft
  // But in CoreImage coords, what was "top" is now "bottom" visually
  // The filter maps: inputTopLeft -> output top-left, etc.
  // Since we flipped Y, our UIKit topLeft is now at a higher Y (visually at top in CoreImage)

  // For CIPerspectiveCorrection, we provide corners as they should MAP to the output rectangle:
  // - inputTopLeft: maps to top-left of output
  // - inputTopRight: maps to top-right of output
  // - inputBottomRight: maps to bottom-right of output
  // - inputBottomLeft: maps to bottom-left of output

  // Since we converted UIKit Y to CoreImage Y, we provide them directly:
  CIVector *topLeft = [CIVector vectorWithX:tlX Y:ciTlY];
  CIVector *topRight = [CIVector vectorWithX:trX Y:ciTrY];
  CIVector *bottomRight = [CIVector vectorWithX:brX Y:ciBrY];
  CIVector *bottomLeft = [CIVector vectorWithX:blX Y:ciBlY];

  // Apply CIPerspectiveCorrection filter
  CIFilter *perspectiveFilter = [CIFilter filterWithName:@"CIPerspectiveCorrection"];
  if (!perspectiveFilter) {
    reject(@"RECTIFY_FAILED", @"CIPerspectiveCorrection filter not available", nil);
    return;
  }

  [perspectiveFilter setValue:ciImage forKey:kCIInputImageKey];
  [perspectiveFilter setValue:topLeft forKey:@"inputTopLeft"];
  [perspectiveFilter setValue:topRight forKey:@"inputTopRight"];
  [perspectiveFilter setValue:bottomRight forKey:@"inputBottomRight"];
  [perspectiveFilter setValue:bottomLeft forKey:@"inputBottomLeft"];

  CIImage *correctedImage = perspectiveFilter.outputImage;
  if (!correctedImage) {
    reject(@"RECTIFY_FAILED", @"CIPerspectiveCorrection produced no output", nil);
    return;
  }

  // Get the extent of the corrected image
  CGRect extent = correctedImage.extent;
  RCTLogInfo(@"[ImagePreprocessor] Corrected image extent: %.1fx%.1f at (%.1f, %.1f)",
             extent.size.width, extent.size.height, extent.origin.x, extent.origin.y);

  // The corrected image may have non-zero origin, so we need to translate it
  if (extent.origin.x != 0 || extent.origin.y != 0) {
    correctedImage = [correctedImage imageByApplyingTransform:CGAffineTransformMakeTranslation(-extent.origin.x, -extent.origin.y)];
    extent = correctedImage.extent;
  }

  // Compute output dimensions
  CGFloat outputWidth = extent.size.width;
  CGFloat outputHeight = extent.size.height;
  CGFloat targetH = [targetHeight floatValue];

  // Scale to target height if specified and positive
  CGFloat scaleFactor = 1.0;
  if (targetH > 0 && outputHeight > 0) {
    scaleFactor = targetH / outputHeight;
    outputWidth = outputWidth * scaleFactor;
    outputHeight = targetH;

    // Apply scale transform
    CIFilter *scaleFilter = [CIFilter filterWithName:@"CILanczosScaleTransform"];
    if (scaleFilter) {
      [scaleFilter setValue:correctedImage forKey:kCIInputImageKey];
      [scaleFilter setValue:@(scaleFactor) forKey:kCIInputScaleKey];
      [scaleFilter setValue:@(1.0) forKey:kCIInputAspectRatioKey];
      correctedImage = scaleFilter.outputImage;
    }
  }

  // Clamp dimensions to reasonable max (2048) to avoid memory issues
  CGFloat maxDimension = 2048.0;
  if (outputWidth > maxDimension || outputHeight > maxDimension) {
    CGFloat clampScale = MIN(maxDimension / outputWidth, maxDimension / outputHeight);
    outputWidth *= clampScale;
    outputHeight *= clampScale;

    CIFilter *clampScaleFilter = [CIFilter filterWithName:@"CILanczosScaleTransform"];
    if (clampScaleFilter) {
      [clampScaleFilter setValue:correctedImage forKey:kCIInputImageKey];
      [clampScaleFilter setValue:@(clampScale) forKey:kCIInputScaleKey];
      [clampScaleFilter setValue:@(1.0) forKey:kCIInputAspectRatioKey];
      correctedImage = clampScaleFilter.outputImage;
    }
  }

  // Render to CGImage
  CIContext *ciContext = [CIContext contextWithOptions:nil];
  extent = correctedImage.extent;
  CGImageRef cgImage = [ciContext createCGImage:correctedImage fromRect:extent];

  if (!cgImage) {
    reject(@"RECTIFY_FAILED", @"Failed to render corrected image", nil);
    return;
  }

  // Convert to UIImage (this also flips back to UIKit coordinates)
  UIImage *outputImage = [UIImage imageWithCGImage:cgImage];
  CGImageRelease(cgImage);

  if (!outputImage) {
    reject(@"RECTIFY_FAILED", @"Failed to create UIImage from CGImage", nil);
    return;
  }

  RCTLogInfo(@"[ImagePreprocessor] Output image size: %.0fx%.0f", outputImage.size.width, outputImage.size.height);

  // Ensure output directory exists
  NSString *outputDir = [cleanOutputPath stringByDeletingLastPathComponent];
  NSError *mkdirError = nil;
  [[NSFileManager defaultManager] createDirectoryAtPath:outputDir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:&mkdirError];
  if (mkdirError) {
    RCTLogInfo(@"[ImagePreprocessor] Warning: mkdir error (may be ok): %@", mkdirError.localizedDescription);
  }

  // Save as JPEG
  NSData *jpegData = UIImageJPEGRepresentation(outputImage, 0.92);
  if (!jpegData) {
    reject(@"RECTIFY_FAILED", @"Failed to create JPEG data", nil);
    return;
  }

  NSError *writeError = nil;
  BOOL success = [jpegData writeToFile:cleanOutputPath options:NSDataWritingAtomic error:&writeError];

  if (!success) {
    reject(@"RECTIFY_FAILED", writeError.localizedDescription, writeError);
    return;
  }

  RCTLogInfo(@"[ImagePreprocessor] ✓ Saved rectified crop: %@ (%.0fx%.0f, %lu bytes)",
             cleanOutputPath, outputImage.size.width, outputImage.size.height, (unsigned long)jpegData.length);

  resolve(@{
    @"path": cleanOutputPath,
    @"width": @((NSInteger)outputImage.size.width),
    @"height": @((NSInteger)outputImage.size.height),
    @"bytes": @(jpegData.length),
    @"method": @"native_coreimage"
  });
}

/**
 * Check if native rectification is available on this device
 */
RCT_EXPORT_METHOD(isRectificationAvailable:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // Check if CIPerspectiveCorrection filter is available
  CIFilter *filter = [CIFilter filterWithName:@"CIPerspectiveCorrection"];
  BOOL available = (filter != nil);

  RCTLogInfo(@"[ImagePreprocessor] isRectificationAvailable: %@", available ? @"YES" : @"NO");

  resolve(@{
    @"available": @(available),
    @"platform": @"ios",
    @"method": @"native_coreimage"
  });
}

/**
 * Create a downscaled display image for UI rendering
 *
 * Reduces large images to a maximum dimension to prevent memory issues
 * and PERF ASSETS warnings when loading in React Native Image component.
 *
 * @param sourcePath Path to source image
 * @param outputPath Path to save display image
 * @param maxDimension Maximum width/height (e.g., 1600)
 * @param quality JPEG quality 0.0-1.0
 */
RCT_EXPORT_METHOD(createDisplayImage:(NSString *)sourcePath
                  outputPath:(NSString *)outputPath
                  maxDimension:(NSInteger)maxDimension
                  quality:(float)quality
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // Clean paths
  NSString *cleanSourcePath = [sourcePath stringByReplacingOccurrencesOfString:@"file://" withString:@""];
  NSString *cleanOutputPath = [outputPath stringByReplacingOccurrencesOfString:@"file://" withString:@""];

  // Load source image
  UIImage *sourceImage = [UIImage imageWithContentsOfFile:cleanSourcePath];
  if (!sourceImage) {
    reject(@"DISPLAY_IMAGE_FAILED", @"Failed to load source image", nil);
    return;
  }

  CGFloat srcWidth = sourceImage.size.width;
  CGFloat srcHeight = sourceImage.size.height;
  CGFloat largestDim = MAX(srcWidth, srcHeight);

  // Check if resize needed
  if (largestDim <= maxDimension) {
    // Already small enough, just copy
    NSData *jpegData = UIImageJPEGRepresentation(sourceImage, quality);
    NSError *writeError = nil;
    [jpegData writeToFile:cleanOutputPath options:NSDataWritingAtomic error:&writeError];

    if (writeError) {
      reject(@"DISPLAY_IMAGE_FAILED", writeError.localizedDescription, writeError);
      return;
    }

    RCTLogInfo(@"[ImagePreprocessor] Display image: no resize needed (%.0fx%.0f)", srcWidth, srcHeight);

    resolve(@{
      @"path": cleanOutputPath,
      @"width": @((NSInteger)srcWidth),
      @"height": @((NSInteger)srcHeight),
      @"sourceWidth": @((NSInteger)srcWidth),
      @"sourceHeight": @((NSInteger)srcHeight),
      @"scale": @(1.0),
      @"resized": @NO
    });
    return;
  }

  // Calculate scale factor
  CGFloat scale = (CGFloat)maxDimension / largestDim;
  CGSize newSize = CGSizeMake(roundf(srcWidth * scale), roundf(srcHeight * scale));

  RCTLogInfo(@"[ImagePreprocessor] Display image: %.0fx%.0f -> %.0fx%.0f (scale=%.3f)",
             srcWidth, srcHeight, newSize.width, newSize.height, scale);

  // Create resized image
  UIGraphicsBeginImageContextWithOptions(newSize, NO, 1.0);
  [sourceImage drawInRect:CGRectMake(0, 0, newSize.width, newSize.height)];
  UIImage *resizedImage = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  if (!resizedImage) {
    reject(@"DISPLAY_IMAGE_FAILED", @"Failed to resize image", nil);
    return;
  }

  // Save as JPEG
  NSData *jpegData = UIImageJPEGRepresentation(resizedImage, quality);
  if (!jpegData) {
    reject(@"DISPLAY_IMAGE_FAILED", @"Failed to create JPEG data", nil);
    return;
  }

  NSError *writeError = nil;
  BOOL success = [jpegData writeToFile:cleanOutputPath options:NSDataWritingAtomic error:&writeError];

  if (!success) {
    reject(@"DISPLAY_IMAGE_FAILED", writeError.localizedDescription, writeError);
    return;
  }

  RCTLogInfo(@"[ImagePreprocessor] ✓ Display image saved: %@ (%.0fx%.0f, %lu bytes)",
             cleanOutputPath, newSize.width, newSize.height, (unsigned long)jpegData.length);

  resolve(@{
    @"path": cleanOutputPath,
    @"width": @((NSInteger)newSize.width),
    @"height": @((NSInteger)newSize.height),
    @"sourceWidth": @((NSInteger)srcWidth),
    @"sourceHeight": @((NSInteger)srcHeight),
    @"scale": @(scale),
    @"resized": @YES
  });
}

/**
 * Enhance image for OCR retry path (grayscale + contrast + sharpen + min-width upscale).
 */
+ (CGImageRef)enhanceForOCR:(CGImageRef)inputImage {
  if (!inputImage) return nil;

  CIImage *ciImage = [CIImage imageWithCGImage:inputImage];
  if (!ciImage) return nil;

  CGFloat width = CGImageGetWidth(inputImage);
  CGFloat height = CGImageGetHeight(inputImage);

  // Upscale to minimum width 300px (uniform scale; no stretching)
  if (width > 0 && width < 300.0f) {
    CGFloat targetWidth = 300.0f;
    CGFloat scaleFactor = targetWidth / width;
    CGFloat scaledHeight = height * scaleFactor;

    CIFilter *scaleFilter = [CIFilter filterWithName:@"CILanczosScaleTransform"];
    if (scaleFilter) {
      [scaleFilter setValue:ciImage forKey:kCIInputImageKey];
      [scaleFilter setValue:@(scaleFactor) forKey:kCIInputScaleKey];
      [scaleFilter setValue:@(1.0f) forKey:kCIInputAspectRatioKey];
      if (scaleFilter.outputImage) {
        ciImage = scaleFilter.outputImage;
      }
    }

    // If needed, letterbox to exactly 300 width with gray bars
    CGRect scaledExtent = ciImage.extent;
    if (scaledExtent.size.width < targetWidth) {
      CGFloat padLeft = (targetWidth - scaledExtent.size.width) * 0.5f;
      CIImage *translated = [ciImage imageByApplyingTransform:CGAffineTransformMakeTranslation(padLeft, 0)];

      CIFilter *colorGen = [CIFilter filterWithName:@"CIConstantColorGenerator"];
      [colorGen setValue:[CIColor colorWithRed:0.5f green:0.5f blue:0.5f alpha:1.0f] forKey:kCIInputColorKey];
      CIImage *background = [[colorGen outputImage] imageByCroppingToRect:CGRectMake(0, 0, targetWidth, scaledHeight)];

      CIFilter *composite = [CIFilter filterWithName:@"CISourceOverCompositing"];
      [composite setValue:translated forKey:kCIInputImageKey];
      [composite setValue:background forKey:kCIInputBackgroundImageKey];
      if (composite.outputImage) {
        ciImage = [composite.outputImage imageByCroppingToRect:CGRectMake(0, 0, targetWidth, scaledHeight)];
      }
    }
  }

  // Grayscale + light contrast bump
  CIFilter *colorControls = [CIFilter filterWithName:@"CIColorControls"];
  if (colorControls) {
    [colorControls setValue:ciImage forKey:kCIInputImageKey];
    [colorControls setValue:@0.0f forKey:kCIInputSaturationKey];
    [colorControls setValue:@1.1f forKey:kCIInputContrastKey];
    [colorControls setValue:@0.0f forKey:kCIInputBrightnessKey];
    if (colorControls.outputImage) {
      ciImage = colorControls.outputImage;
    }
  }

  // Unsharp mask for text edges
  CIFilter *unsharp = [CIFilter filterWithName:@"CIUnsharpMask"];
  if (unsharp) {
    [unsharp setValue:ciImage forKey:kCIInputImageKey];
    [unsharp setValue:@1.5f forKey:kCIInputRadiusKey];
    [unsharp setValue:@0.5f forKey:kCIInputIntensityKey];
    if (unsharp.outputImage) {
      ciImage = unsharp.outputImage;
    }
  }

  CGRect extent = ciImage.extent;
  CIContext *context = [CIContext contextWithOptions:nil];
  return [context createCGImage:ciImage fromRect:extent];
}

/**
 * Combined rectification + OCR path.
 * OCR runs on in-memory image to avoid JPEG quality loss.
 */
RCT_EXPORT_METHOD(rectifyAndRecognize:(NSString *)imagePath
                  corners:(NSDictionary *)corners
                  outputPath:(NSString *)outputPath
                  targetHeight:(NSNumber *)targetHeight
                  recognitionLevel:(NSString *)recognitionLevel
                  languages:(NSArray<NSString *> *)languages
                  rotationsToTry:(NSArray<NSNumber *> *)rotationsToTry
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  if (@available(iOS 13.0, *)) {

  NSString *cleanInputPath = imagePath;
  if ([cleanInputPath hasPrefix:@"file://"]) {
    cleanInputPath = [cleanInputPath substringFromIndex:7];
  }

  NSString *cleanOutputPath = outputPath;
  if ([cleanOutputPath hasPrefix:@"file://"]) {
    cleanOutputPath = [cleanOutputPath substringFromIndex:7];
  }

  NSDictionary *tlDict = corners[@"topLeft"];
  NSDictionary *trDict = corners[@"topRight"];
  NSDictionary *brDict = corners[@"bottomRight"];
  NSDictionary *blDict = corners[@"bottomLeft"];
  if (!tlDict || !trDict || !brDict || !blDict) {
    reject(@"RECTIFY_OCR_FAILED", @"Missing corner coordinates", nil);
    return;
  }

  CGFloat tlX = [tlDict[@"x"] floatValue];
  CGFloat tlY = [tlDict[@"y"] floatValue];
  CGFloat trX = [trDict[@"x"] floatValue];
  CGFloat trY = [trDict[@"y"] floatValue];
  CGFloat brX = [brDict[@"x"] floatValue];
  CGFloat brY = [brDict[@"y"] floatValue];
  CGFloat blX = [blDict[@"x"] floatValue];
  CGFloat blY = [blDict[@"y"] floatValue];

  UIImage *rawImage = [UIImage imageWithContentsOfFile:cleanInputPath];
  if (!rawImage) {
    reject(@"RECTIFY_OCR_FAILED", [NSString stringWithFormat:@"Failed to load image: %@", cleanInputPath], nil);
    return;
  }

  UIImage *image = [ImagePreprocessor normalizeImageOrientation:rawImage];
  CGFloat imageHeight = image.size.height;

  CIImage *ciImage = [[CIImage alloc] initWithImage:image];
  if (!ciImage) {
    reject(@"RECTIFY_OCR_FAILED", @"Failed to create CIImage", nil);
    return;
  }

  CIVector *topLeft = [CIVector vectorWithX:tlX Y:(imageHeight - tlY)];
  CIVector *topRight = [CIVector vectorWithX:trX Y:(imageHeight - trY)];
  CIVector *bottomRight = [CIVector vectorWithX:brX Y:(imageHeight - brY)];
  CIVector *bottomLeft = [CIVector vectorWithX:blX Y:(imageHeight - blY)];

  CIFilter *perspectiveFilter = [CIFilter filterWithName:@"CIPerspectiveCorrection"];
  if (!perspectiveFilter) {
    reject(@"RECTIFY_OCR_FAILED", @"CIPerspectiveCorrection not available", nil);
    return;
  }

  [perspectiveFilter setValue:ciImage forKey:kCIInputImageKey];
  [perspectiveFilter setValue:topLeft forKey:@"inputTopLeft"];
  [perspectiveFilter setValue:topRight forKey:@"inputTopRight"];
  [perspectiveFilter setValue:bottomRight forKey:@"inputBottomRight"];
  [perspectiveFilter setValue:bottomLeft forKey:@"inputBottomLeft"];

  CIImage *correctedImage = perspectiveFilter.outputImage;
  if (!correctedImage) {
    reject(@"RECTIFY_OCR_FAILED", @"CIPerspectiveCorrection produced no output", nil);
    return;
  }

  CGRect extent = correctedImage.extent;
  if (extent.origin.x != 0 || extent.origin.y != 0) {
    correctedImage = [correctedImage imageByApplyingTransform:CGAffineTransformMakeTranslation(-extent.origin.x, -extent.origin.y)];
    extent = correctedImage.extent;
  }

  CGFloat outputHeight = extent.size.height;
  CGFloat targetH = [targetHeight floatValue];
  if (targetH > 0 && outputHeight > 0) {
    CGFloat scaleFactor = targetH / outputHeight;
    CIFilter *scaleFilter = [CIFilter filterWithName:@"CILanczosScaleTransform"];
    if (scaleFilter) {
      [scaleFilter setValue:correctedImage forKey:kCIInputImageKey];
      [scaleFilter setValue:@(scaleFactor) forKey:kCIInputScaleKey];
      [scaleFilter setValue:@(1.0f) forKey:kCIInputAspectRatioKey];
      if (scaleFilter.outputImage) {
        correctedImage = scaleFilter.outputImage;
      }
    }
  }

  CGFloat maxDimension = 2048.0f;
  extent = correctedImage.extent;
  CGFloat outputWidth = extent.size.width;
  outputHeight = extent.size.height;
  if (outputWidth > maxDimension || outputHeight > maxDimension) {
    CGFloat clampScale = MIN(maxDimension / outputWidth, maxDimension / outputHeight);
    CIFilter *clampScaleFilter = [CIFilter filterWithName:@"CILanczosScaleTransform"];
    if (clampScaleFilter) {
      [clampScaleFilter setValue:correctedImage forKey:kCIInputImageKey];
      [clampScaleFilter setValue:@(clampScale) forKey:kCIInputScaleKey];
      [clampScaleFilter setValue:@(1.0f) forKey:kCIInputAspectRatioKey];
      if (clampScaleFilter.outputImage) {
        correctedImage = clampScaleFilter.outputImage;
      }
    }
  }

  CIContext *context = [CIContext contextWithOptions:nil];
  extent = correctedImage.extent;
  CGImageRef rectifiedCGImage = [context createCGImage:correctedImage fromRect:extent];
  if (!rectifiedCGImage) {
    reject(@"RECTIFY_OCR_FAILED", @"Failed to render corrected image", nil);
    return;
  }

  UIImage *rectifiedUIImage = [UIImage imageWithCGImage:rectifiedCGImage];
  if (!rectifiedUIImage) {
    CGImageRelease(rectifiedCGImage);
    reject(@"RECTIFY_OCR_FAILED", @"Failed to create UIImage from rectified image", nil);
    return;
  }

  if (cleanOutputPath && cleanOutputPath.length > 0) {
    NSString *outputDir = [cleanOutputPath stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:outputDir
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    NSData *debugJpegData = UIImageJPEGRepresentation(rectifiedUIImage, 0.92f);
    [debugJpegData writeToFile:cleanOutputPath options:NSDataWritingAtomic error:nil];
  }

  NSDictionary *rectifyResult = @{
    @"path": cleanOutputPath ?: @"",
    @"width": @((NSInteger)CGImageGetWidth(rectifiedCGImage)),
    @"height": @((NSInteger)CGImageGetHeight(rectifiedCGImage)),
    @"method": @"native_coreimage"
  };

  NSArray<NSNumber *> *rotations =
      ([rotationsToTry isKindOfClass:[NSArray class]] && rotationsToTry.count > 0)
          ? rotationsToTry
          : @[@0, @90];
  NSString *ocrLevel = recognitionLevel ?: @"accurate";
  NSArray<NSString *> *safeLanguages = [languages isKindOfClass:[NSArray class]] ? languages : nil;

  NSDate *startTime = [NSDate date];

  __block NSMutableDictionary *bestResult = nil;
  __block NSDictionary *bestMetrics = nil;
  __block NSInteger bestRotation = 0;
  __block NSMutableDictionary<NSNumber *, NSArray *> *allRotationLines = [NSMutableDictionary dictionary];
  __block NSError *lastError = nil;

  dispatch_group_t group = dispatch_group_create();
  dispatch_queue_t queue = dispatch_queue_create("com.bookscanner.rectify_ocr", DISPATCH_QUEUE_SERIAL);

  for (NSNumber *rotation in rotations) {
    dispatch_group_enter(group);
    dispatch_async(queue, ^{
      NSInteger rotationDegrees = [rotation integerValue];

      dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
      void (^handleResult)(NSArray<NSDictionary *> *, NSError *) = ^(NSArray<NSDictionary *> *lines, NSError *error) {
        if (error) {
          lastError = error;
        } else {
          NSDictionary *metrics = [TextRecognizer calculateMetricsForLines:lines];
          @synchronized (self) {
            allRotationLines[@(rotationDegrees)] = lines;
            if (!bestMetrics ||
                [TextRecognizer compareMetricsA:metrics withB:bestMetrics] == NSOrderedAscending) {
              bestMetrics = metrics;
              bestRotation = rotationDegrees;
              NSMutableString *fullText = [NSMutableString string];
              for (NSDictionary *line in lines) {
                if (fullText.length > 0) [fullText appendString:@"\n"];
                [fullText appendString:line[@"text"]];
              }
              NSDictionary *titleAuthor = [TextRecognizer extractTitleAuthorFromLines:lines];
              bestResult = [@{
                @"ok": @YES,
                @"chosenRotation": @(rotationDegrees),
                @"fullText": fullText,
                @"lines": lines,
                @"avgConfidence": metrics[@"avgConfidence"],
                @"alnumRatio": metrics[@"alnumRatio"],
                @"charCount": metrics[@"charCount"],
                @"lineCount": metrics[@"lineCount"],
                @"titleCandidate": titleAuthor[@"titleCandidate"],
                @"authorCandidate": titleAuthor[@"authorCandidate"]
              } mutableCopy];
            }
          }
        }
        dispatch_semaphore_signal(semaphore);
      };

      if (rotationDegrees == 0) {
        [TextRecognizer recognizeTextInCGImage:rectifiedCGImage
                              recognitionLevel:ocrLevel
                                     languages:safeLanguages
                                    completion:handleResult];
      } else {
        UIImage *rotatedImage = [TextRecognizer rotateImage:rectifiedUIImage byDegrees:rotationDegrees];
        [TextRecognizer recognizeTextInImage:rotatedImage
                            recognitionLevel:ocrLevel
                                   languages:safeLanguages
                                  completion:handleResult];
      }

      dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
      dispatch_group_leave(group);
    });
  }

    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
    NSTimeInterval processingTime = [[NSDate date] timeIntervalSinceDate:startTime] * 1000;

    if (!bestResult) {
      CGImageRelease(rectifiedCGImage);
      resolve(@{
        @"rectifyResult": rectifyResult,
        @"ocrResult": @{
          @"ok": @NO,
          @"error": lastError ? lastError.localizedDescription : @"No text found",
          @"chosenRotation": @0,
          @"fullText": @"",
          @"lines": @[],
          @"avgConfidence": @0,
          @"alnumRatio": @0,
          @"charCount": @0,
          @"lineCount": @0,
          @"titleCandidate": [NSNull null],
          @"authorCandidate": [NSNull null],
          @"processingTimeMs": @(processingTime),
          @"platform": @"ios",
          @"combinedPath": @YES
        }
      });
      return;
    }

    NSMutableArray *mergedLines = [NSMutableArray array];
    NSMutableSet *seenTexts = [NSMutableSet set];
    for (NSDictionary *line in bestResult[@"lines"]) {
      NSString *text = [line[@"text"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
      NSString *normalized = [[text lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
      if (normalized.length >= 2 && ![seenTexts containsObject:normalized]) {
        [seenTexts addObject:normalized];
        [mergedLines addObject:line];
      }
    }

    NSInteger complementaryRotation = (bestRotation + 90) % 360;
    NSArray *complementaryLines = allRotationLines[@(complementaryRotation)];
    if (!complementaryLines) {
      for (NSNumber *rotation in rotations) {
        NSInteger candidateRotation = [rotation integerValue];
        if (candidateRotation == bestRotation) continue;
        complementaryRotation = candidateRotation;
        complementaryLines = allRotationLines[@(candidateRotation)];
        if (complementaryLines) break;
      }
    }
    if (complementaryLines) {
      for (NSDictionary *line in complementaryLines) {
        NSString *text = [line[@"text"] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        NSString *normalized = [[text lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (normalized.length < 3) continue;
        if ([seenTexts containsObject:normalized]) continue;

        BOOL isSubstring = NO;
        for (NSString *existing in seenTexts) {
          if ([existing containsString:normalized] || [normalized containsString:existing]) {
            isSubstring = YES;
            break;
          }
        }
        if (isSubstring) continue;

        [seenTexts addObject:normalized];
        [mergedLines addObject:line];
      }
    }

    NSMutableString *mergedFullText = [NSMutableString string];
    for (NSDictionary *line in mergedLines) {
      if (mergedFullText.length > 0) [mergedFullText appendString:@"\n"];
      [mergedFullText appendString:line[@"text"]];
    }

    NSDictionary *mergedMetrics = [TextRecognizer calculateMetricsForLines:mergedLines];
    NSDictionary *mergedTitleAuthor = [TextRecognizer extractTitleAuthorFromLines:mergedLines];

    bestResult[@"fullText"] = mergedFullText;
    bestResult[@"lines"] = mergedLines;
    bestResult[@"avgConfidence"] = mergedMetrics[@"avgConfidence"];
    bestResult[@"alnumRatio"] = mergedMetrics[@"alnumRatio"];
    bestResult[@"charCount"] = mergedMetrics[@"charCount"];
    bestResult[@"lineCount"] = mergedMetrics[@"lineCount"];
    bestResult[@"titleCandidate"] = mergedTitleAuthor[@"titleCandidate"];
    bestResult[@"authorCandidate"] = mergedTitleAuthor[@"authorCandidate"];
    bestResult[@"processingTimeMs"] = @(processingTime);
    bestResult[@"platform"] = @"ios";
    bestResult[@"recognitionLevel"] = ocrLevel;
    bestResult[@"mergedRotations"] = @YES;
    bestResult[@"combinedPath"] = @YES;

    CGFloat avgConfidence = [mergedMetrics[@"avgConfidence"] floatValue];
    if (avgConfidence < 0.4f) {
      CGImageRef enhancedCGImage = [ImagePreprocessor enhanceForOCR:rectifiedCGImage];
      if (enhancedCGImage) {
        UIImage *enhancedUIImage = [UIImage imageWithCGImage:enhancedCGImage];
        CGImageRelease(enhancedCGImage);

        if (enhancedUIImage) {
          dispatch_semaphore_t enhanceSema = dispatch_semaphore_create(0);
          __block NSArray<NSDictionary *> *enhancedLines = nil;

          void (^enhancedHandler)(NSArray<NSDictionary *> *, NSError *) = ^(NSArray<NSDictionary *> *lines, NSError *error) {
            if (!error && lines) {
              enhancedLines = lines;
            }
            dispatch_semaphore_signal(enhanceSema);
          };

          if (bestRotation == 0) {
            [TextRecognizer recognizeTextInCGImage:enhancedUIImage.CGImage
                                  recognitionLevel:ocrLevel
                                         languages:safeLanguages
                                        completion:enhancedHandler];
          } else {
            UIImage *enhancedRotated = [TextRecognizer rotateImage:enhancedUIImage byDegrees:bestRotation];
            [TextRecognizer recognizeTextInImage:enhancedRotated
                                recognitionLevel:ocrLevel
                                       languages:safeLanguages
                                      completion:enhancedHandler];
          }
          dispatch_semaphore_wait(enhanceSema, DISPATCH_TIME_FOREVER);

          if (enhancedLines) {
            NSDictionary *enhancedMetrics = [TextRecognizer calculateMetricsForLines:enhancedLines];
            if ([TextRecognizer compareMetricsA:enhancedMetrics withB:mergedMetrics] == NSOrderedAscending) {
              NSMutableString *enhancedFullText = [NSMutableString string];
              for (NSDictionary *line in enhancedLines) {
                if (enhancedFullText.length > 0) [enhancedFullText appendString:@"\n"];
                [enhancedFullText appendString:line[@"text"]];
              }
              NSDictionary *enhancedTitleAuthor = [TextRecognizer extractTitleAuthorFromLines:enhancedLines];

              bestResult[@"fullText"] = enhancedFullText;
              bestResult[@"lines"] = enhancedLines;
              bestResult[@"avgConfidence"] = enhancedMetrics[@"avgConfidence"];
              bestResult[@"alnumRatio"] = enhancedMetrics[@"alnumRatio"];
              bestResult[@"charCount"] = enhancedMetrics[@"charCount"];
              bestResult[@"lineCount"] = enhancedMetrics[@"lineCount"];
              bestResult[@"titleCandidate"] = enhancedTitleAuthor[@"titleCandidate"];
              bestResult[@"authorCandidate"] = enhancedTitleAuthor[@"authorCandidate"];
              bestResult[@"enhanced"] = @YES;
            }
          }
        }
      }
    }

    NSTimeInterval totalTime = [[NSDate date] timeIntervalSinceDate:startTime] * 1000;
    bestResult[@"processingTimeMs"] = @(totalTime);
    CGImageRelease(rectifiedCGImage);

    resolve(@{
      @"rectifyResult": rectifyResult,
      @"ocrResult": bestResult
    });
    });
  } else {
    reject(@"RECTIFY_OCR_FAILED", @"Requires iOS 13.0+", nil);
  }
}

@end
