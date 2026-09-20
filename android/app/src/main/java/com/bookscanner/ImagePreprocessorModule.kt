package com.bookscanner

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap

/**
 * ImagePreprocessorModule - Android placeholder for native image preprocessing.
 *
 * STATUS: the spine-scanning pipeline does NOT run on Android. This module is a stub.
 *
 * Implemented:
 * - isRectificationAvailable: returns false
 * - rectifyPerspective: returns skipped status
 *
 * NOT implemented - the pipeline (src/services/pipelineService.ts) requires all three,
 * and probes for them by name, so Android fails early with an explanatory message:
 * - getImageDecodeStats(imagePath)     -> { width, height, byteLength, globalMin, globalMax }
 * - preprocessForTFLite(path, size, pad) -> { tensorBase64, tensorStats, previewBase64RGBA, nativeTruth }
 * - savePreviewImage(rgbaBase64, w, h, outPath)
 *
 * To bring Android up, port those from ios/ImagePreprocessor.m (Bitmap + Matrix is
 * sufficient for the perspective transform; OpenCV is not required) AND bundle the
 * model at android/app/src/main/assets/models/yolov8_obb.tflite - it is absent today,
 * so loadModel() cannot succeed either. OCR (TextRecognizerModule) is already done.
 */
class ImagePreprocessorModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "ImagePreprocessor"

    /**
     * Check if native rectification is available on this device
     * Android: Currently not implemented, returns false
     */
    @ReactMethod
    fun isRectificationAvailable(promise: Promise) {
        val result = WritableNativeMap().apply {
            putBoolean("available", false)
            putString("platform", "android")
            putString("method", "not_implemented")
            putString("reason", "Android native rectification not yet implemented")
        }
        promise.resolve(result)
    }

    /**
     * Rectify a quadrilateral region - PLACEHOLDER
     * Returns skipped status since Android implementation is not ready
     */
    @ReactMethod
    fun rectifyPerspective(
        imagePath: String,
        corners: ReadableMap,
        outputPath: String,
        targetHeight: Double,
        promise: Promise
    ) {
        // Return skipped status - Android implementation not yet available
        val result = WritableNativeMap().apply {
            putString("path", "")
            putInt("width", 0)
            putInt("height", 0)
            putInt("bytes", 0)
            putString("method", "skipped")
            putString("skippedReason", "android_not_implemented")
        }
        promise.resolve(result)
    }
}
