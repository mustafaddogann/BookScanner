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
  UIImage *image = [UIImage imageWithContentsOfFile:cleanPath];
  if (!image) {
    reject(@"DECODE_FAILED", [NSString stringWithFormat:@"Failed to load image: %@", cleanPath], nil);
    return;
  }

  CGImageRef cgImage = image.CGImage;
  if (!cgImage) {
    reject(@"DECODE_FAILED", @"Failed to get CGImage", nil);
    return;
  }

  size_t width = CGImageGetWidth(cgImage);
  size_t height = CGImageGetHeight(cgImage);
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
  UIImage *image = [UIImage imageWithContentsOfFile:cleanPath];
  if (!image) {
    reject(@"PREPROCESS_FAILED", [NSString stringWithFormat:@"Failed to load image: %@", cleanPath], nil);
    return;
  }

  CGImageRef cgImage = image.CGImage;
  if (!cgImage) {
    reject(@"PREPROCESS_FAILED", @"Failed to get CGImage", nil);
    return;
  }

  size_t srcWidth = CGImageGetWidth(cgImage);
  size_t srcHeight = CGImageGetHeight(cgImage);

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

@end
