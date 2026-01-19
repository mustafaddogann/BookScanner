package com.bookscanner

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap

/**
 * ImagePreprocessorModule - Android placeholder for native image preprocessing
 *
 * Currently provides:
 * - isRectificationAvailable: Returns false (not yet implemented)
 * - rectifyPerspective: Returns skipped status
 *
 * TODO: Implement rectification using Android APIs (e.g., OpenCV, RenderScript, or Matrix transforms)
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
