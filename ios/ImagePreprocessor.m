/**
 * ImagePreprocessor - Native module for image preprocessing
 *
 * Provides:
 * 1. Image decoding (JPEG/PNG to RGB bytes)
 * 2. Letterbox resizing with padding
 * 3. Float32 tensor generation for TFLite
 */

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

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

@end
