/**
 * TextRecognizer - Native module for on-device OCR using Apple Vision
 *
 * Provides:
 * 1. Text recognition availability check
 * 2. Multi-rotation text recognition with best rotation selection
 * 3. Title/author extraction heuristics
 */

@import Foundation;
@import UIKit;
@import Vision;
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

@interface TextRecognizer : NSObject <RCTBridgeModule>
@end

@implementation TextRecognizer

RCT_EXPORT_MODULE();

#pragma mark - Availability Check

/**
 * Check if text recognition is available on this device
 */
RCT_EXPORT_METHOD(isTextRecognitionAvailable:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  // VNRecognizeTextRequest is available on iOS 13+
  if (@available(iOS 13.0, *)) {
    resolve(@{
      @"available": @YES,
      @"platform": @"ios",
      @"method": @"apple_vision",
      @"minimumOSVersion": @"13.0"
    });
  } else {
    resolve(@{
      @"available": @NO,
      @"platform": @"ios",
      @"method": @"none",
      @"reason": @"iOS 13.0+ required for Vision text recognition"
    });
  }
}

#pragma mark - Image Rotation Helper

/**
 * Rotate a UIImage by the specified degrees (0, 90, 180, 270)
 */
+ (UIImage *)rotateImage:(UIImage *)image byDegrees:(NSInteger)degrees {
  if (degrees == 0) {
    return image;
  }

  CGFloat radians = degrees * M_PI / 180.0;
  CGSize rotatedSize;

  if (degrees == 90 || degrees == 270) {
    rotatedSize = CGSizeMake(image.size.height, image.size.width);
  } else {
    rotatedSize = image.size;
  }

  UIGraphicsBeginImageContextWithOptions(rotatedSize, NO, image.scale);
  CGContextRef context = UIGraphicsGetCurrentContext();

  // Move origin to center, rotate, then move back
  CGContextTranslateCTM(context, rotatedSize.width / 2, rotatedSize.height / 2);
  CGContextRotateCTM(context, radians);

  // Draw the image centered at origin
  [image drawInRect:CGRectMake(-image.size.width / 2, -image.size.height / 2,
                                image.size.width, image.size.height)];

  UIImage *rotatedImage = UIGraphicsGetImageFromCurrentImageContext();
  UIGraphicsEndImageContext();

  return rotatedImage;
}

#pragma mark - Text Recognition Core

/**
 * Perform text recognition on a single image
 * Returns array of line dictionaries with text, bbox, and confidence
 */
+ (void)recognizeTextInImage:(UIImage *)image
            recognitionLevel:(NSString *)level
                   languages:(NSArray<NSString *> *)languages
                  completion:(void (^)(NSArray<NSDictionary *> *lines, NSError *error))completion
    API_AVAILABLE(ios(13.0))
{
  CGImageRef cgImage = image.CGImage;
  if (!cgImage) {
    completion(nil, [NSError errorWithDomain:@"TextRecognizer"
                                        code:1
                                    userInfo:@{NSLocalizedDescriptionKey: @"Failed to get CGImage"}]);
    return;
  }

  // Capture image dimensions for use in completion handler
  CGFloat imageWidth = CGImageGetWidth(cgImage);
  CGFloat imageHeight = CGImageGetHeight(cgImage);

  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] initWithCompletionHandler:^(VNRequest * _Nonnull request, NSError * _Nullable error) {
    if (error) {
      completion(nil, error);
      return;
    }

    NSMutableArray<NSDictionary *> *results = [NSMutableArray array];

    for (VNRecognizedTextObservation *observation in request.results) {
      VNRecognizedText *topCandidate = [[observation topCandidates:1] firstObject];
      if (!topCandidate) continue;

      NSString *text = topCandidate.string;
      CGFloat confidence = topCandidate.confidence;

      // Convert normalized bbox to pixel coordinates
      // Vision uses bottom-left origin, we convert to top-left
      CGRect bbox = observation.boundingBox;
      CGFloat x = bbox.origin.x * imageWidth;
      CGFloat y = (1.0 - bbox.origin.y - bbox.size.height) * imageHeight; // Flip Y
      CGFloat w = bbox.size.width * imageWidth;
      CGFloat h = bbox.size.height * imageHeight;

      [results addObject:@{
        @"text": text,
        @"bbox": @{
          @"x": @(x),
          @"y": @(y),
          @"width": @(w),
          @"height": @(h)
        },
        @"confidence": @(confidence)
      }];
    }

    completion(results, nil);
  }];

  // Set recognition level
  if ([level isEqualToString:@"fast"]) {
    request.recognitionLevel = VNRequestTextRecognitionLevelFast;
  } else {
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  }

  // Enable language correction for better results
  request.usesLanguageCorrection = YES;

  // Set languages if provided (iOS 13+)
  if (languages && languages.count > 0) {
    NSError *langError = nil;
    NSArray *supported = [request supportedRecognitionLanguagesAndReturnError:&langError];
    if (!langError) {
      NSMutableArray *validLanguages = [NSMutableArray array];
      for (NSString *lang in languages) {
        if ([supported containsObject:lang]) {
          [validLanguages addObject:lang];
        }
      }
      if (validLanguages.count > 0) {
        request.recognitionLanguages = validLanguages;
      }
    }
  }

  // Perform the request
  VNImageRequestHandler *imageHandler = [[VNImageRequestHandler alloc] initWithCGImage:cgImage options:@{}];

  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSError *performError = nil;
    [imageHandler performRequests:@[request] error:&performError];
    if (performError) {
      dispatch_async(dispatch_get_main_queue(), ^{
        completion(nil, performError);
      });
    }
  });
}

#pragma mark - Scoring and Selection

/**
 * Calculate alphanumeric ratio for a string
 */
+ (CGFloat)alnumRatioForString:(NSString *)str {
  if (str.length == 0) return 0;

  NSUInteger alnumCount = 0;
  for (NSUInteger i = 0; i < str.length; i++) {
    unichar c = [str characterAtIndex:i];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
      alnumCount++;
    }
  }
  return (CGFloat)alnumCount / str.length;
}

/**
 * Calculate scoring metrics for OCR results
 */
+ (NSDictionary *)calculateMetricsForLines:(NSArray<NSDictionary *> *)lines {
  if (lines.count == 0) {
    return @{
      @"avgConfidence": @0,
      @"alnumRatio": @0,
      @"charCount": @0,
      @"lineCount": @0
    };
  }

  CGFloat totalConfidence = 0;
  NSUInteger totalChars = 0;
  NSMutableString *allText = [NSMutableString string];

  for (NSDictionary *line in lines) {
    NSString *text = line[@"text"];
    CGFloat confidence = [line[@"confidence"] floatValue];

    totalConfidence += confidence;
    totalChars += text.length;
    [allText appendString:text];
  }

  CGFloat avgConfidence = totalConfidence / lines.count;
  CGFloat alnumRatio = [self alnumRatioForString:allText];

  return @{
    @"avgConfidence": @(avgConfidence),
    @"alnumRatio": @(alnumRatio),
    @"charCount": @(totalChars),
    @"lineCount": @(lines.count)
  };
}

/**
 * Compare two rotation results and return which is better
 * Returns -1 if a is better, 1 if b is better, 0 if equal
 */
+ (NSComparisonResult)compareMetricsA:(NSDictionary *)a withB:(NSDictionary *)b {
  CGFloat confA = [a[@"avgConfidence"] floatValue];
  CGFloat confB = [b[@"avgConfidence"] floatValue];

  // Primary: avgConfidence
  if (fabs(confA - confB) > 0.01) {
    return confA > confB ? NSOrderedAscending : NSOrderedDescending;
  }

  CGFloat alnumA = [a[@"alnumRatio"] floatValue];
  CGFloat alnumB = [b[@"alnumRatio"] floatValue];

  // Secondary: alnumRatio
  if (fabs(alnumA - alnumB) > 0.01) {
    return alnumA > alnumB ? NSOrderedAscending : NSOrderedDescending;
  }

  NSUInteger charsA = [a[@"charCount"] unsignedIntegerValue];
  NSUInteger charsB = [b[@"charCount"] unsignedIntegerValue];

  // Tertiary: charCount
  if (charsA != charsB) {
    return charsA > charsB ? NSOrderedAscending : NSOrderedDescending;
  }

  return NSOrderedSame;
}

#pragma mark - Title/Author Heuristics

/**
 * Check if a line has high symbol density (likely not useful text)
 */
+ (BOOL)hasHighSymbolDensity:(NSString *)text {
  if (text.length < 2) return YES;

  CGFloat alnumRatio = [self alnumRatioForString:text];
  return alnumRatio < 0.5; // More than 50% symbols/spaces
}

/**
 * Normalize whitespace in a string
 */
+ (NSString *)normalizeWhitespace:(NSString *)text {
  // Replace multiple whitespace with single space and trim
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"\\s+"
                                                                         options:0
                                                                           error:nil];
  NSString *normalized = [regex stringByReplacingMatchesInString:text
                                                         options:0
                                                           range:NSMakeRange(0, text.length)
                                                    withTemplate:@" "];
  return [normalized stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
}

/**
 * Check if a string looks like a person name (2-4 tokens, mostly letters)
 */
+ (BOOL)looksLikePersonName:(NSString *)text {
  NSString *normalized = [self normalizeWhitespace:text];
  NSArray *tokens = [normalized componentsSeparatedByString:@" "];

  // Should have 2-4 tokens
  if (tokens.count < 2 || tokens.count > 4) return NO;

  // Each token should be mostly letters and start with uppercase
  for (NSString *token in tokens) {
    if (token.length < 2) return NO;

    unichar firstChar = [token characterAtIndex:0];
    if (!(firstChar >= 'A' && firstChar <= 'Z')) return NO;

    // Count letters
    NSUInteger letterCount = 0;
    for (NSUInteger i = 0; i < token.length; i++) {
      unichar c = [token characterAtIndex:i];
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
        letterCount++;
      }
    }
    if ((CGFloat)letterCount / token.length < 0.8) return NO;
  }

  return YES;
}

/**
 * Extract title and author candidates from OCR lines
 */
+ (NSDictionary *)extractTitleAuthorFromLines:(NSArray<NSDictionary *> *)lines {
  NSString *titleCandidate = [NSNull null];
  NSString *authorCandidate = [NSNull null];

  if (lines.count == 0) {
    return @{@"titleCandidate": titleCandidate, @"authorCandidate": authorCandidate};
  }

  // Build list of clean lines (not high symbol density)
  NSMutableArray *cleanLines = [NSMutableArray array];
  for (NSDictionary *line in lines) {
    NSString *text = [self normalizeWhitespace:line[@"text"]];
    if (text.length < 2) continue;
    if ([self hasHighSymbolDensity:text]) continue;

    [cleanLines addObject:@{
      @"text": text,
      @"confidence": line[@"confidence"],
      @"charCount": @(text.length),
      @"alnumRatio": @([self alnumRatioForString:text])
    }];
  }

  if (cleanLines.count == 0) {
    return @{@"titleCandidate": titleCandidate, @"authorCandidate": authorCandidate};
  }

  // Look for author patterns first
  NSInteger authorIndex = -1;
  for (NSUInteger i = 0; i < cleanLines.count; i++) {
    NSString *text = cleanLines[i][@"text"];
    NSString *lower = [text lowercaseString];

    // Check for "by " prefix
    if ([lower hasPrefix:@"by "]) {
      NSString *afterBy = [text substringFromIndex:3];
      afterBy = [self normalizeWhitespace:afterBy];
      if (afterBy.length >= 2) {
        authorCandidate = afterBy;
        authorIndex = i;
        break;
      }
    }

    // Check if looks like a person name
    if ([self looksLikePersonName:text]) {
      authorCandidate = text;
      authorIndex = i;
      break;
    }
  }

  // Sort remaining lines by quality for title selection
  NSMutableArray *titleCandidates = [NSMutableArray array];
  for (NSUInteger i = 0; i < cleanLines.count; i++) {
    if ((NSInteger)i == authorIndex) continue;
    [titleCandidates addObject:cleanLines[i]];
  }

  // Sort by: charCount desc, alnumRatio desc, confidence desc
  [titleCandidates sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    // Primary: charCount (prefer longer titles)
    NSUInteger charsA = [a[@"charCount"] unsignedIntegerValue];
    NSUInteger charsB = [b[@"charCount"] unsignedIntegerValue];
    if (charsA != charsB) {
      return charsA > charsB ? NSOrderedAscending : NSOrderedDescending;
    }

    // Secondary: alnumRatio
    CGFloat alnumA = [a[@"alnumRatio"] floatValue];
    CGFloat alnumB = [b[@"alnumRatio"] floatValue];
    if (fabs(alnumA - alnumB) > 0.01) {
      return alnumA > alnumB ? NSOrderedAscending : NSOrderedDescending;
    }

    // Tertiary: confidence
    CGFloat confA = [a[@"confidence"] floatValue];
    CGFloat confB = [b[@"confidence"] floatValue];
    return confA > confB ? NSOrderedAscending : NSOrderedDescending;
  }];

  // Take best title candidate
  if (titleCandidates.count > 0) {
    titleCandidate = titleCandidates[0][@"text"];
  }

  // If no author found but we have multiple clean lines, use second-best as author
  if ([authorCandidate isEqual:[NSNull null]] && titleCandidates.count > 1) {
    authorCandidate = titleCandidates[1][@"text"];
  }

  return @{
    @"titleCandidate": titleCandidate ?: [NSNull null],
    @"authorCandidate": authorCandidate ?: [NSNull null]
  };
}

#pragma mark - Main Recognition Method

/**
 * Recognize text in an image, trying multiple rotations
 */
RCT_EXPORT_METHOD(recognizeText:(NSDictionary *)options
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  if (@available(iOS 13.0, *)) {
    NSString *imagePath = options[@"imagePath"];
    NSArray<NSNumber *> *rotationsToTry = options[@"rotationsToTry"] ?: @[@0, @90, @180, @270];
    NSString *recognitionLevel = options[@"recognitionLevel"] ?: @"accurate";
    NSArray<NSString *> *languages = options[@"languages"];

    // Clean path
    NSString *cleanPath = imagePath;
    if ([cleanPath hasPrefix:@"file://"]) {
      cleanPath = [cleanPath substringFromIndex:7];
    }

    RCTLogInfo(@"[TextRecognizer] Starting OCR for: %@", cleanPath);
    RCTLogInfo(@"[TextRecognizer] Rotations to try: %@", rotationsToTry);

    NSDate *startTime = [NSDate date];

    // Load image
    UIImage *originalImage = [UIImage imageWithContentsOfFile:cleanPath];
    if (!originalImage) {
      resolve(@{
        @"ok": @NO,
        @"error": [NSString stringWithFormat:@"Failed to load image: %@", cleanPath],
        @"chosenRotation": @0,
        @"fullText": @"",
        @"lines": @[],
        @"avgConfidence": @0,
        @"alnumRatio": @0,
        @"charCount": @0,
        @"lineCount": @0,
        @"titleCandidate": [NSNull null],
        @"authorCandidate": [NSNull null]
      });
      return;
    }

    RCTLogInfo(@"[TextRecognizer] Image loaded: %.0fx%.0f", originalImage.size.width, originalImage.size.height);

    // Process each rotation
    __block NSMutableDictionary *bestResult = nil;
    __block NSDictionary *bestMetrics = nil;
    __block NSInteger bestRotation = 0;
    __block NSInteger completedRotations = 0;
    __block NSError *lastError = nil;

    dispatch_group_t group = dispatch_group_create();
    dispatch_queue_t queue = dispatch_queue_create("com.bookscanner.ocr", DISPATCH_QUEUE_SERIAL);

    for (NSNumber *rotation in rotationsToTry) {
      dispatch_group_enter(group);

      dispatch_async(queue, ^{
        NSInteger rotationDegrees = [rotation integerValue];
        UIImage *rotatedImage = [TextRecognizer rotateImage:originalImage byDegrees:rotationDegrees];

        dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);

        [TextRecognizer recognizeTextInImage:rotatedImage
                            recognitionLevel:recognitionLevel
                                   languages:languages
                                  completion:^(NSArray<NSDictionary *> *lines, NSError *error) {
          if (error) {
            lastError = error;
            RCTLogInfo(@"[TextRecognizer] Rotation %ld failed: %@", (long)rotationDegrees, error.localizedDescription);
          } else {
            NSDictionary *metrics = [TextRecognizer calculateMetricsForLines:lines];

            RCTLogInfo(@"[TextRecognizer] Rotation %ld: lines=%lu, avgConf=%.3f, alnum=%.3f, chars=%@",
                      (long)rotationDegrees,
                      (unsigned long)lines.count,
                      [metrics[@"avgConfidence"] floatValue],
                      [metrics[@"alnumRatio"] floatValue],
                      metrics[@"charCount"]);

            // Check if this is better than current best
            @synchronized (self) {
              if (bestMetrics == nil ||
                  [TextRecognizer compareMetricsA:metrics withB:bestMetrics] == NSOrderedAscending) {
                bestMetrics = metrics;
                bestRotation = rotationDegrees;

                // Build full text
                NSMutableString *fullText = [NSMutableString string];
                for (NSDictionary *line in lines) {
                  if (fullText.length > 0) [fullText appendString:@"\n"];
                  [fullText appendString:line[@"text"]];
                }

                // Extract title/author
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
        }];

        dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
        completedRotations++;
        dispatch_group_leave(group);
      });
    }

    // Wait for all rotations to complete
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
      NSTimeInterval processingTime = [[NSDate date] timeIntervalSinceDate:startTime] * 1000;

      if (bestResult) {
        bestResult[@"processingTimeMs"] = @(processingTime);
        bestResult[@"platform"] = @"ios";
        bestResult[@"recognitionLevel"] = recognitionLevel;

        RCTLogInfo(@"[TextRecognizer] Best rotation: %ld degrees, processed in %.0fms",
                  (long)bestRotation, processingTime);

        resolve(bestResult);
      } else {
        resolve(@{
          @"ok": @NO,
          @"error": lastError ? lastError.localizedDescription : @"No text found in any rotation",
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
          @"platform": @"ios"
        });
      }
    });

  } else {
    resolve(@{
      @"ok": @NO,
      @"error": @"Text recognition requires iOS 13.0+",
      @"skippedReason": @"ios_version_too_low",
      @"chosenRotation": @0,
      @"fullText": @"",
      @"lines": @[],
      @"avgConfidence": @0,
      @"alnumRatio": @0,
      @"charCount": @0,
      @"lineCount": @0,
      @"titleCandidate": [NSNull null],
      @"authorCandidate": [NSNull null],
      @"platform": @"ios"
    });
  }
}

@end
