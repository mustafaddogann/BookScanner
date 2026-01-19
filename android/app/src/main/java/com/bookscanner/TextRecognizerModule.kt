package com.bookscanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.bridge.WritableNativeArray
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import kotlin.math.max

/**
 * TextRecognizerModule - Android native OCR using ML Kit Text Recognition
 *
 * Provides:
 * 1. Text recognition availability check
 * 2. Multi-rotation text recognition with best rotation selection
 * 3. Title/author extraction heuristics
 */
class TextRecognizerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "TextRecognizer"

    private val recognizer: TextRecognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    /**
     * Check if text recognition is available on this device
     */
    @ReactMethod
    fun isTextRecognitionAvailable(promise: Promise) {
        val result = WritableNativeMap().apply {
            putBoolean("available", true)
            putString("platform", "android")
            putString("method", "mlkit_text_recognition")
        }
        promise.resolve(result)
    }

    /**
     * Recognize text in an image, trying multiple rotations
     */
    @ReactMethod
    fun recognizeText(options: ReadableMap, promise: Promise) {
        val startTime = System.currentTimeMillis()

        // Parse options
        val imagePath = options.getString("imagePath") ?: run {
            resolveError(promise, "imagePath is required")
            return
        }

        val rotationsToTry = if (options.hasKey("rotationsToTry")) {
            options.getArray("rotationsToTry")?.toArrayList()?.map { (it as Number).toInt() }
                ?: listOf(0, 90, 180, 270)
        } else {
            listOf(0, 90, 180, 270)
        }

        val recognitionLevel = options.getString("recognitionLevel") ?: "accurate"

        // Clean path
        val cleanPath = imagePath.removePrefix("file://")

        android.util.Log.i("TextRecognizer", "Starting OCR for: $cleanPath")
        android.util.Log.i("TextRecognizer", "Rotations to try: $rotationsToTry")

        // Load bitmap
        val originalBitmap = try {
            BitmapFactory.decodeFile(cleanPath)
        } catch (e: Exception) {
            resolveError(promise, "Failed to load image: ${e.message}")
            return
        }

        if (originalBitmap == null) {
            resolveError(promise, "Failed to decode image: $cleanPath")
            return
        }

        android.util.Log.i("TextRecognizer", "Image loaded: ${originalBitmap.width}x${originalBitmap.height}")

        // Process rotations sequentially
        processRotations(
            originalBitmap,
            rotationsToTry,
            recognitionLevel,
            startTime,
            promise
        )
    }

    private fun processRotations(
        originalBitmap: Bitmap,
        rotations: List<Int>,
        recognitionLevel: String,
        startTime: Long,
        promise: Promise
    ) {
        val results = mutableListOf<RotationResult>()
        var pendingCount = rotations.size

        for (rotation in rotations) {
            val rotatedBitmap = rotateBitmap(originalBitmap, rotation)
            val inputImage = InputImage.fromBitmap(rotatedBitmap, 0)

            recognizer.process(inputImage)
                .addOnSuccessListener { visionText ->
                    val lines = mutableListOf<LineData>()

                    for (block in visionText.textBlocks) {
                        for (line in block.lines) {
                            val bbox = line.boundingBox
                            if (bbox != null) {
                                lines.add(LineData(
                                    text = line.text,
                                    x = bbox.left.toDouble(),
                                    y = bbox.top.toDouble(),
                                    width = bbox.width().toDouble(),
                                    height = bbox.height().toDouble(),
                                    confidence = line.confidence?.toDouble() ?: 0.9
                                ))
                            }
                        }
                    }

                    val metrics = calculateMetrics(lines)
                    android.util.Log.i("TextRecognizer",
                        "Rotation $rotation: lines=${lines.size}, avgConf=${metrics.avgConfidence}, " +
                        "alnum=${metrics.alnumRatio}, chars=${metrics.charCount}")

                    synchronized(results) {
                        results.add(RotationResult(rotation, lines, metrics))
                        pendingCount--

                        if (pendingCount == 0) {
                            // All rotations complete, find best
                            val best = results.maxWithOrNull(compareBy(
                                { it.metrics.avgConfidence },
                                { it.metrics.alnumRatio },
                                { it.metrics.charCount }
                            ))

                            if (best != null && best.lines.isNotEmpty()) {
                                val processingTime = System.currentTimeMillis() - startTime
                                resolveSuccess(promise, best, processingTime, recognitionLevel)
                            } else {
                                val processingTime = System.currentTimeMillis() - startTime
                                resolveEmpty(promise, processingTime)
                            }

                            // Clean up
                            if (rotatedBitmap != originalBitmap) {
                                rotatedBitmap.recycle()
                            }
                        }
                    }
                }
                .addOnFailureListener { e ->
                    android.util.Log.e("TextRecognizer", "Rotation $rotation failed: ${e.message}")

                    synchronized(results) {
                        pendingCount--

                        if (pendingCount == 0) {
                            val best = results.maxWithOrNull(compareBy(
                                { it.metrics.avgConfidence },
                                { it.metrics.alnumRatio },
                                { it.metrics.charCount }
                            ))

                            if (best != null && best.lines.isNotEmpty()) {
                                val processingTime = System.currentTimeMillis() - startTime
                                resolveSuccess(promise, best, processingTime, recognitionLevel)
                            } else {
                                val processingTime = System.currentTimeMillis() - startTime
                                resolveError(promise, "No text found: ${e.message}")
                            }
                        }
                    }
                }
        }
    }

    private fun rotateBitmap(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees == 0) return bitmap

        val matrix = Matrix().apply {
            postRotate(degrees.toFloat())
        }

        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun calculateMetrics(lines: List<LineData>): Metrics {
        if (lines.isEmpty()) {
            return Metrics(0.0, 0.0, 0, 0)
        }

        val totalConfidence = lines.sumOf { it.confidence }
        val avgConfidence = totalConfidence / lines.size

        val allText = lines.joinToString("") { it.text }
        val charCount = allText.length
        val alnumCount = allText.count { it.isLetterOrDigit() }
        val alnumRatio = if (charCount > 0) alnumCount.toDouble() / charCount else 0.0

        return Metrics(avgConfidence, alnumRatio, charCount, lines.size)
    }

    private fun extractTitleAuthor(lines: List<LineData>): Pair<String?, String?> {
        if (lines.isEmpty()) return Pair(null, null)

        // Filter clean lines
        val cleanLines = lines.filter { line ->
            val text = line.text.trim()
            text.length >= 2 && !hasHighSymbolDensity(text)
        }.map { line ->
            val text = normalizeWhitespace(line.text)
            CleanLine(text, line.confidence, text.length, alnumRatio(text))
        }

        if (cleanLines.isEmpty()) return Pair(null, null)

        var authorCandidate: String? = null
        var authorIndex = -1

        // Look for author patterns
        for ((index, clean) in cleanLines.withIndex()) {
            val lower = clean.text.lowercase()

            // Check for "by " prefix
            if (lower.startsWith("by ")) {
                val afterBy = clean.text.substring(3).trim()
                if (afterBy.length >= 2) {
                    authorCandidate = afterBy
                    authorIndex = index
                    break
                }
            }

            // Check if looks like person name
            if (looksLikePersonName(clean.text)) {
                authorCandidate = clean.text
                authorIndex = index
                break
            }
        }

        // Get title candidates (excluding author)
        val titleCandidates = cleanLines.filterIndexed { index, _ -> index != authorIndex }
            .sortedWith(compareByDescending<CleanLine> { it.charCount }
                .thenByDescending { it.alnumRatio }
                .thenByDescending { it.confidence })

        val titleCandidate = titleCandidates.firstOrNull()?.text

        // If no author found and we have multiple lines, use second best
        if (authorCandidate == null && titleCandidates.size > 1) {
            authorCandidate = titleCandidates[1].text
        }

        return Pair(titleCandidate, authorCandidate)
    }

    private fun hasHighSymbolDensity(text: String): Boolean {
        if (text.length < 2) return true
        return alnumRatio(text) < 0.5
    }

    private fun alnumRatio(text: String): Double {
        if (text.isEmpty()) return 0.0
        val alnumCount = text.count { it.isLetterOrDigit() }
        return alnumCount.toDouble() / text.length
    }

    private fun normalizeWhitespace(text: String): String {
        return text.trim().replace(Regex("\\s+"), " ")
    }

    private fun looksLikePersonName(text: String): Boolean {
        val normalized = normalizeWhitespace(text)
        val tokens = normalized.split(" ")

        // Should have 2-4 tokens
        if (tokens.size !in 2..4) return false

        // Each token should be mostly letters and start with uppercase
        for (token in tokens) {
            if (token.length < 2) return false
            if (!token[0].isUpperCase()) return false

            val letterCount = token.count { it.isLetter() }
            if (letterCount.toDouble() / token.length < 0.8) return false
        }

        return true
    }

    private fun resolveSuccess(promise: Promise, result: RotationResult, processingTimeMs: Long, recognitionLevel: String) {
        val (titleCandidate, authorCandidate) = extractTitleAuthor(result.lines)

        val fullText = result.lines.joinToString("\n") { it.text }

        val linesArray = WritableNativeArray().apply {
            for (line in result.lines) {
                val lineMap = WritableNativeMap().apply {
                    putString("text", line.text)
                    putMap("bbox", WritableNativeMap().apply {
                        putDouble("x", line.x)
                        putDouble("y", line.y)
                        putDouble("width", line.width)
                        putDouble("height", line.height)
                    })
                    putDouble("confidence", line.confidence)
                }
                pushMap(lineMap)
            }
        }

        val resultMap = WritableNativeMap().apply {
            putBoolean("ok", true)
            putInt("chosenRotation", result.rotation)
            putString("fullText", fullText)
            putArray("lines", linesArray)
            putDouble("avgConfidence", result.metrics.avgConfidence)
            putDouble("alnumRatio", result.metrics.alnumRatio)
            putInt("charCount", result.metrics.charCount)
            putInt("lineCount", result.metrics.lineCount)
            if (titleCandidate != null) putString("titleCandidate", titleCandidate) else putNull("titleCandidate")
            if (authorCandidate != null) putString("authorCandidate", authorCandidate) else putNull("authorCandidate")
            putDouble("processingTimeMs", processingTimeMs.toDouble())
            putString("platform", "android")
            putString("recognitionLevel", recognitionLevel)
        }

        android.util.Log.i("TextRecognizer", "Best rotation: ${result.rotation} degrees, processed in ${processingTimeMs}ms")

        promise.resolve(resultMap)
    }

    private fun resolveEmpty(promise: Promise, processingTimeMs: Long) {
        val resultMap = WritableNativeMap().apply {
            putBoolean("ok", false)
            putString("error", "No text found in any rotation")
            putInt("chosenRotation", 0)
            putString("fullText", "")
            putArray("lines", WritableNativeArray())
            putDouble("avgConfidence", 0.0)
            putDouble("alnumRatio", 0.0)
            putInt("charCount", 0)
            putInt("lineCount", 0)
            putNull("titleCandidate")
            putNull("authorCandidate")
            putDouble("processingTimeMs", processingTimeMs.toDouble())
            putString("platform", "android")
        }

        promise.resolve(resultMap)
    }

    private fun resolveError(promise: Promise, error: String) {
        val resultMap = WritableNativeMap().apply {
            putBoolean("ok", false)
            putString("error", error)
            putInt("chosenRotation", 0)
            putString("fullText", "")
            putArray("lines", WritableNativeArray())
            putDouble("avgConfidence", 0.0)
            putDouble("alnumRatio", 0.0)
            putInt("charCount", 0)
            putInt("lineCount", 0)
            putNull("titleCandidate")
            putNull("authorCandidate")
            putString("platform", "android")
        }

        promise.resolve(resultMap)
    }

    // Data classes
    data class LineData(
        val text: String,
        val x: Double,
        val y: Double,
        val width: Double,
        val height: Double,
        val confidence: Double
    )

    data class Metrics(
        val avgConfidence: Double,
        val alnumRatio: Double,
        val charCount: Int,
        val lineCount: Int
    )

    data class RotationResult(
        val rotation: Int,
        val lines: List<LineData>,
        val metrics: Metrics
    )

    data class CleanLine(
        val text: String,
        val confidence: Double,
        val charCount: Int,
        val alnumRatio: Double
    )
}
