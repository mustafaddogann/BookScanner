/**
 * ResultsScreen - Shows image with SVG overlay and tap selection
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  LayoutChangeEvent,
  ActivityIndicator,
  Share,
  Alert,
  Platform,
} from 'react-native';
import Svg, { Polygon, Circle, Text as SvgText } from 'react-native-svg';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, OBBDetection, OBBCorners, ScreenMapping, SerializedFrameGeo, OCRResult } from '../types';
import { obbToCorners, mapCornersToScreen, calculateScreenMapping } from '../utils/letterbox';
import { useAppStore, type SessionMeta, type DetectionRectifyInfo } from '../store/useAppStore';
import { readDebugManifest, getSessionDir } from '../services/debugArtifacts';
import { recognizeCropText, isTextRecognitionAvailable } from '../services/textRecognitionService';
import RNFS from 'react-native-fs';

// Tab options for switching between overlay and crops views
type ResultsTab = 'overlay' | 'crops';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Results'>;
type ResultsRouteProp = RouteProp<RootStackParamList, 'Results'>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function ResultsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ResultsRouteProp>();
  const { sessionId } = route.params;

  const {
    detections,
    selectedDetectionIndex,
    setSelectedDetection,
    currentSession,
    sessionMeta,
  } = useAppStore();

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [containerLayout, setContainerLayout] = useState<{ width: number; height: number } | null>(null);
  const [screenMapping, setScreenMapping] = useState<ScreenMapping | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Tab and crop selection state
  const [activeTab, setActiveTab] = useState<ResultsTab>('overlay');
  const [selectedCropIndex, setSelectedCropIndex] = useState<number | null>(null);

  // Get rectification results from sessionMeta
  const rectificationResults = sessionMeta?.rectificationResults || [];
  const rectificationSummary = sessionMeta?.rectificationSummary;
  const hasSuccessfulCrops = rectificationSummary ? rectificationSummary.succeeded > 0 :
    rectificationResults.some(r => r.cropUri && r.rectificationMethod !== 'skipped');

  // Get OCR results from sessionMeta
  const ocrResults = sessionMeta?.ocrResultsByCropIndex || {};
  const ocrSummary = sessionMeta?.ocrSummary;
  const userEdits = sessionMeta?.userEdits || {};

  // State for OCR processing
  const [ocrProcessing, setOcrProcessing] = useState<number | null>(null);
  const [ocrAvailable, setOcrAvailable] = useState<boolean | null>(null);

  // Check OCR availability on mount
  useEffect(() => {
    isTextRecognitionAvailable().then(result => {
      setOcrAvailable(result.available);
    });
  }, []);

  // Load session data with robust guards
  // PRIORITY: 1) Store sessionMeta (in-memory) 2) debug_manifest.json (legacy fallback)
  useEffect(() => {
    async function loadSession() {
      try {
        const sessionDir = getSessionDir(sessionId);

        // ================================================================
        // STEP 1: Try to get geometry from in-memory store (PREFERRED)
        // ================================================================
        let foundImageUri: string | null = null;
        let foundDimensions: { width: number; height: number } | null = null;
        let usedStore = false;

        if (sessionMeta) {
          console.log('[Results] Using sessionMeta from store (single source of truth)');

          // Get dimensions from store
          if (sessionMeta.imageDimensions) {
            foundDimensions = sessionMeta.imageDimensions;
            console.log(`[Results] Store dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
          } else if (sessionMeta.frameGeo) {
            foundDimensions = {
              width: sessionMeta.frameGeo.pixelW,
              height: sessionMeta.frameGeo.pixelH,
            };
            console.log(`[Results] Store frameGeo dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
          }

          // Get image path from store
          if (sessionMeta.normalizedImagePath) {
            const normalizedExists = await RNFS.exists(sessionMeta.normalizedImagePath);
            if (normalizedExists) {
              foundImageUri = `file://${sessionMeta.normalizedImagePath}`;
              console.log('[Results] Using normalizedImagePath from store');
            }
          }

          usedStore = !!foundDimensions;
        }

        // ================================================================
        // STEP 2: Find display image (if not found from store)
        // ================================================================
        if (!foundImageUri) {
          // Priority order for display image:
          // 1. input_normalized.jpg (EXIF-corrected, matches detection coordinates)
          // 2. original.jpg (raw camera output)
          // 3. original.png (alternative format)
          const normalizedPath = `${sessionDir}/input_normalized.jpg`;
          const jpgPath = `${sessionDir}/original.jpg`;
          const pngPath = `${sessionDir}/original.png`;

          if (await RNFS.exists(normalizedPath)) {
            foundImageUri = `file://${normalizedPath}`;
            console.log('[Results] Using input_normalized.jpg for display');
          } else if (await RNFS.exists(jpgPath)) {
            foundImageUri = `file://${jpgPath}`;
            console.log('[Results] Falling back to original.jpg');
          } else if (await RNFS.exists(pngPath)) {
            foundImageUri = `file://${pngPath}`;
            console.log('[Results] Falling back to original.png');
          }
        }

        setImageUri(foundImageUri);

        // ================================================================
        // STEP 3: Fall back to debug_manifest.json for legacy sessions
        // ================================================================
        if (!foundDimensions) {
          console.log('[Results] Store empty, falling back to debug_manifest.json');

          try {
            const manifest = await readDebugManifest(sessionId);

            if (manifest) {
              // Try FrameGeo first
              const frameGeo = manifest.frameGeo as SerializedFrameGeo | undefined;
              if (frameGeo && typeof frameGeo.pixelW === 'number' && typeof frameGeo.pixelH === 'number') {
                foundDimensions = { width: frameGeo.pixelW, height: frameGeo.pixelH };
                console.log(`[Results] Manifest frameGeo dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
              } else if (manifest.imageMeta && typeof manifest.imageMeta.width === 'number') {
                foundDimensions = { width: manifest.imageMeta.width, height: manifest.imageMeta.height };
                console.log(`[Results] Manifest imageMeta dimensions: ${foundDimensions.width}x${foundDimensions.height}`);
              }

              // Load detections from manifest if store is empty
              if (detections.length === 0) {
                const manifestDetections = manifest.detectionsOriginal || manifest.detectionsFrameSpace || [];
                console.log(`[Results] Loading ${manifestDetections.length} detections from manifest`);
                if (Array.isArray(manifestDetections)) {
                  useAppStore.getState().setDetections(manifestDetections);
                }
              }
            }
          } catch (manifestError: any) {
            // debug_manifest.json may not exist if DEBUG_ARTIFACTS_ENABLED=false
            // This is expected - not an error
            console.log(`[Results] No debug_manifest.json (artifacts disabled): ${manifestError.message}`);
          }
        }

        // ================================================================
        // STEP 4: Last resort - use Image.getSize
        // ================================================================
        if (!foundDimensions && foundImageUri) {
          console.warn('[Results] No dimensions from store or manifest, using Image.getSize fallback');
          try {
            const { Image: RNImage } = await import('react-native');
            await new Promise<void>((resolve, reject) => {
              RNImage.getSize(
                foundImageUri!,
                (w, h) => {
                  console.warn(`[Results] Image.getSize: ${w}x${h} - coordinates may not match detections!`);
                  foundDimensions = { width: w, height: h };
                  resolve();
                },
                (err) => {
                  console.error('[Results] Image.getSize failed:', err);
                  reject(err);
                }
              );
            });
          } catch {
            console.warn('[Results] Could not determine image dimensions');
          }
        }

        // Set dimensions
        if (foundDimensions) {
          setImageDimensions(foundDimensions);
        }

        // Log detection count
        console.log(`[Results] ${detections.length} detections available for rendering`);

        // Show warning if no dimensions found
        if (!foundDimensions && !foundImageUri) {
          setLoadError('Session data not found. The session may have been deleted.');
        }
      } catch (error: any) {
        console.error('[Results] Failed to load session:', error);
        setLoadError(`Failed to load session: ${error.message}`);
      } finally {
        setLoading(false);
      }
    }

    loadSession();
  }, [sessionId, sessionMeta]);

  // Calculate screen mapping when container layout changes
  useEffect(() => {
    if (!containerLayout || !imageDimensions) return;

    const mapping = calculateScreenMapping(
      imageDimensions.width,
      imageDimensions.height,
      containerLayout.width,
      containerLayout.height,
      containerLayout.width,
      containerLayout.height
    );

    setScreenMapping(mapping);
    console.log('[Results] Screen mapping calculated:', mapping);
  }, [containerLayout, imageDimensions]);

  // Handle container layout
  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainerLayout({ width, height });
  }, []);

  // Handle detection tap
  const handleDetectionTap = useCallback((index: number) => {
    setSelectedDetection(selectedDetectionIndex === index ? null : index);
  }, [selectedDetectionIndex, setSelectedDetection]);

  // Convert OBB to screen-space polygon points
  const getPolygonPoints = useCallback((obb: OBBDetection, index: number): string => {
    if (!screenMapping) return '';

    const corners = obbToCorners(obb);
    const screenCorners = mapCornersToScreen(corners, screenMapping);

    // Debug log for first few detections
    if (index < 3) {
      console.log(`[Results] Detection ${index}:`);
      console.log(`  OBB: cx=${obb.cx.toFixed(1)}, cy=${obb.cy.toFixed(1)}, w=${obb.width.toFixed(1)}, h=${obb.height.toFixed(1)}, angle=${obb.angle.toFixed(4)} rad (${(obb.angle * 180 / Math.PI).toFixed(1)}°)`);
      console.log(`  Corners (image): TL=(${corners.topLeft.x.toFixed(1)},${corners.topLeft.y.toFixed(1)}), TR=(${corners.topRight.x.toFixed(1)},${corners.topRight.y.toFixed(1)})`);
      console.log(`  Corners (screen): TL=(${screenCorners.topLeft.x.toFixed(1)},${screenCorners.topLeft.y.toFixed(1)}), TR=(${screenCorners.topRight.x.toFixed(1)},${screenCorners.topRight.y.toFixed(1)})`);
    }

    return [
      `${screenCorners.topLeft.x},${screenCorners.topLeft.y}`,
      `${screenCorners.topRight.x},${screenCorners.topRight.y}`,
      `${screenCorners.bottomRight.x},${screenCorners.bottomRight.y}`,
      `${screenCorners.bottomLeft.x},${screenCorners.bottomLeft.y}`,
    ].join(' ');
  }, [screenMapping]);

  // Get center point in screen space for label
  const getScreenCenter = useCallback((obb: OBBDetection): { x: number; y: number } => {
    if (!screenMapping) return { x: 0, y: 0 };

    return {
      x: obb.cx * screenMapping.scale + screenMapping.offsetX,
      y: obb.cy * screenMapping.scale + screenMapping.offsetY,
    };
  }, [screenMapping]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // Handle crop selection - also select corresponding detection
  const handleCropTap = useCallback((index: number) => {
    const newIndex = selectedCropIndex === index ? null : index;
    setSelectedCropIndex(newIndex);
    // Also select the corresponding detection
    setSelectedDetection(newIndex);
  }, [selectedCropIndex, setSelectedDetection]);

  // Share a crop image
  const handleShareCrop = useCallback(async (cropInfo: DetectionRectifyInfo) => {
    if (!cropInfo.cropUri) {
      Alert.alert('Share Unavailable', 'This crop was not generated.');
      return;
    }

    try {
      const filePath = cropInfo.cropUri.replace('file://', '');

      // Verify file exists
      const exists = await RNFS.exists(filePath);
      if (!exists) {
        Alert.alert('File Not Found', 'The crop file could not be found.');
        return;
      }

      if (Platform.OS === 'ios') {
        await Share.share({
          url: cropInfo.cropUri,
        });
      } else {
        // Android - share as file URI
        await Share.share({
          message: `Book spine crop ${cropInfo.detectionIndex + 1}`,
          url: cropInfo.cropUri,
        });
      }
    } catch (error: any) {
      if (error.message !== 'User did not share') {
        console.error('[Results] Share error:', error);
        Alert.alert('Share Failed', error.message || 'Failed to share the crop.');
      }
    }
  }, []);

  // Share all successful crops
  const handleShareAllCrops = useCallback(async () => {
    const successfulCrops = rectificationResults.filter(r => r.cropUri && r.rectificationMethod !== 'skipped');
    if (successfulCrops.length === 0) {
      Alert.alert('No Crops', 'No successful crops available to share.');
      return;
    }

    if (successfulCrops.length === 1) {
      // Single crop - share directly
      await handleShareCrop(successfulCrops[0]);
      return;
    }

    // Multiple crops - on iOS, share all URLs
    if (Platform.OS === 'ios') {
      try {
        // iOS can share multiple files using activityItems (not directly in Share API)
        // For now, show alert to share individually
        Alert.alert(
          'Share Crops',
          `${successfulCrops.length} crops available. Tap on individual crops to share them.`,
          [{ text: 'OK' }]
        );
      } catch (error: any) {
        console.error('[Results] Share all error:', error);
      }
    } else {
      Alert.alert(
        'Share Crops',
        `${successfulCrops.length} crops available. Tap on individual crops to share them.`,
        [{ text: 'OK' }]
      );
    }
  }, [rectificationResults, handleShareCrop]);

  // Run OCR on a single crop
  const handleRunOCR = useCallback(async (cropIndex: number) => {
    const cropInfo = rectificationResults[cropIndex];
    if (!cropInfo?.cropUri || !ocrAvailable) {
      Alert.alert('OCR Unavailable', 'Cannot run OCR on this crop.');
      return;
    }

    setOcrProcessing(cropIndex);

    try {
      const result = await recognizeCropText(cropInfo.cropUri, sessionId, cropIndex);

      // Update sessionMeta with new OCR result
      const currentMeta = useAppStore.getState().sessionMeta;
      if (currentMeta) {
        const newOcrResults = { ...currentMeta.ocrResultsByCropIndex, [cropIndex]: result };
        useAppStore.getState().setSessionMeta({
          ...currentMeta,
          ocrResultsByCropIndex: newOcrResults,
        });
      }

      if (result.ok) {
        console.log(`[Results] OCR completed for crop ${cropIndex}: "${result.titleCandidate}"`);
      } else {
        console.log(`[Results] OCR failed for crop ${cropIndex}: ${result.error || result.skippedReason}`);
      }
    } catch (error: any) {
      console.error(`[Results] OCR error for crop ${cropIndex}:`, error);
      Alert.alert('OCR Error', error.message || 'Failed to run OCR');
    } finally {
      setOcrProcessing(null);
    }
  }, [rectificationResults, sessionId, ocrAvailable]);

  // Update user edit for a crop
  const handleUpdateUserEdit = useCallback((cropIndex: number, field: 'title' | 'author', value: string) => {
    const currentMeta = useAppStore.getState().sessionMeta;
    if (!currentMeta) return;

    const currentEdits = currentMeta.userEdits || {};
    const cropEdits = currentEdits[cropIndex] || {};

    useAppStore.getState().setSessionMeta({
      ...currentMeta,
      userEdits: {
        ...currentEdits,
        [cropIndex]: {
          ...cropEdits,
          [field]: value,
        },
      },
    });
  }, []);

  // Get display title/author for a crop (user edit takes precedence)
  const getDisplayText = useCallback((cropIndex: number): { title: string | null; author: string | null } => {
    const edit = userEdits[cropIndex];
    const ocr = ocrResults[cropIndex];

    return {
      title: edit?.title ?? ocr?.titleCandidate ?? null,
      author: edit?.author ?? ocr?.authorCandidate ?? null,
    };
  }, [userEdits, ocrResults]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading results...</Text>
      </View>
    );
  }

  // Safe empty state when no image dimensions available
  const canRenderOverlay = screenMapping && imageDimensions;

  return (
    <View style={styles.container}>
      {/* Error banner */}
      {loadError && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{loadError}</Text>
        </View>
      )}

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Results</Text>
        <Text style={styles.detectionCount}>{detections.length} detected</Text>
      </View>

      {/* Tab bar for switching between Overlay and Crops views */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'overlay' && styles.tabActive]}
          onPress={() => setActiveTab('overlay')}
        >
          <Text style={[styles.tabText, activeTab === 'overlay' && styles.tabTextActive]}>
            Overlay
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'crops' && styles.tabActive]}
          onPress={() => setActiveTab('crops')}
        >
          <Text style={[styles.tabText, activeTab === 'crops' && styles.tabTextActive]}>
            Crops {hasSuccessfulCrops && `(${rectificationSummary?.succeeded || rectificationResults.filter(r => r.cropUri).length})`}
          </Text>
        </TouchableOpacity>
      </View>

      {/* OVERLAY VIEW - Image with detection overlay */}
      {activeTab === 'overlay' && (
        <View style={styles.imageContainer} onLayout={handleContainerLayout}>
          {imageUri && (
            <Image
              source={{ uri: imageUri }}
              style={styles.image}
              resizeMode="contain"
            />
          )}

          {/* SVG Overlay - only render if we have valid mapping */}
          {canRenderOverlay && (
            <Svg style={StyleSheet.absoluteFill}>
              {detections.map((detection, index) => {
                const isSelected = selectedDetectionIndex === index;
                const center = getScreenCenter(detection);

                return (
                  <React.Fragment key={index}>
                    {/* OBB polygon */}
                    <Polygon
                      points={getPolygonPoints(detection, index)}
                      fill={isSelected ? 'rgba(0, 122, 255, 0.3)' : 'rgba(255, 149, 0, 0.2)'}
                      stroke={isSelected ? '#007AFF' : '#FF9500'}
                      strokeWidth={isSelected ? 3 : 2}
                      onPress={() => handleDetectionTap(index)}
                    />

                    {/* Center point */}
                    <Circle
                      cx={center.x}
                      cy={center.y}
                      r={isSelected ? 6 : 4}
                      fill={isSelected ? '#007AFF' : '#FF9500'}
                      onPress={() => handleDetectionTap(index)}
                    />

                    {/* Index label */}
                    <SvgText
                      x={center.x}
                      y={center.y - 12}
                      fill={isSelected ? '#007AFF' : '#FF9500'}
                      fontSize={12}
                      fontWeight="bold"
                      textAnchor="middle"
                    >
                      {index + 1}
                    </SvgText>
                  </React.Fragment>
                );
              })}
            </Svg>
          )}
        </View>
      )}

      {/* CROPS VIEW - Grid of rectified crop images */}
      {activeTab === 'crops' && (
        <View style={styles.cropsContainer}>
          {!hasSuccessfulCrops ? (
            // No crops available message
            <View style={styles.noCropsContainer}>
              <Text style={styles.noCropsTitle}>Rectification Unavailable</Text>
              <Text style={styles.noCropsMessage}>
                {Platform.OS === 'android'
                  ? 'Native rectification is not yet implemented on Android. Crops will be available in a future update.'
                  : 'No crops were generated for this session. This may be due to a processing error.'}
              </Text>
              {rectificationSummary && (
                <Text style={styles.noCropsStats}>
                  {rectificationSummary.total} detection{rectificationSummary.total !== 1 ? 's' : ''}, {rectificationSummary.skipped} skipped
                </Text>
              )}
            </View>
          ) : (
            // Crops grid
            <ScrollView contentContainerStyle={styles.cropsScrollContent}>
              {/* Share all button */}
              <TouchableOpacity style={styles.shareAllButton} onPress={handleShareAllCrops}>
                <Text style={styles.shareAllButtonText}>Share Crops</Text>
              </TouchableOpacity>

              {/* Crops grid */}
              <View style={styles.cropsGrid}>
                {rectificationResults.map((cropInfo, index) => {
                  const isSelected = selectedCropIndex === index;
                  const hasCrop = cropInfo.cropUri && cropInfo.rectificationMethod !== 'skipped';
                  const ocrResult = ocrResults[index];
                  const displayText = getDisplayText(index);
                  const isOcrProcessing = ocrProcessing === index;
                  const hasOcr = ocrResult?.ok;
                  const needsOcr = hasCrop && !hasOcr && ocrAvailable;

                  return (
                    <View key={index} style={styles.cropCardContainer}>
                      <TouchableOpacity
                        style={[
                          styles.cropCard,
                          isSelected && styles.cropCardSelected,
                          !hasCrop && styles.cropCardSkipped,
                        ]}
                        onPress={() => hasCrop && handleCropTap(index)}
                        onLongPress={() => hasCrop && handleShareCrop(cropInfo)}
                        disabled={!hasCrop}
                      >
                        {hasCrop ? (
                          <>
                            <Image
                              source={{ uri: cropInfo.cropUri! }}
                              style={styles.cropImage}
                              resizeMode="contain"
                            />
                            <View style={styles.cropOverlay}>
                              <Text style={styles.cropIndex}>{index + 1}</Text>
                            </View>
                            {/* OCR confidence badge */}
                            {hasOcr && (
                              <View style={styles.ocrBadge}>
                                <Text style={styles.ocrBadgeText}>
                                  {Math.round(ocrResult.avgConfidence * 100)}%
                                </Text>
                              </View>
                            )}
                            {/* Processing indicator */}
                            {isOcrProcessing && (
                              <View style={styles.ocrProcessingOverlay}>
                                <ActivityIndicator size="small" color="#fff" />
                              </View>
                            )}
                            {isSelected && (
                              <TouchableOpacity
                                style={styles.cropShareButton}
                                onPress={() => handleShareCrop(cropInfo)}
                              >
                                <Text style={styles.cropShareButtonText}>Share</Text>
                              </TouchableOpacity>
                            )}
                          </>
                        ) : (
                          <View style={styles.cropSkippedContent}>
                            <Text style={styles.cropSkippedIndex}>{index + 1}</Text>
                            <Text style={styles.cropSkippedText}>Skipped</Text>
                            {cropInfo.skippedReason && (
                              <Text style={styles.cropSkippedReason}>
                                {cropInfo.skippedReason.replace(/_/g, ' ')}
                              </Text>
                            )}
                          </View>
                        )}
                      </TouchableOpacity>

                      {/* OCR Results below crop */}
                      {hasCrop && (
                        <View style={styles.ocrInfoContainer}>
                          {hasOcr ? (
                            <>
                              {displayText.title && (
                                <Text style={styles.ocrTitle} numberOfLines={2}>
                                  {displayText.title}
                                </Text>
                              )}
                              {displayText.author && (
                                <Text style={styles.ocrAuthor} numberOfLines={1}>
                                  {displayText.author}
                                </Text>
                              )}
                              {!displayText.title && !displayText.author && (
                                <Text style={styles.ocrNoText}>No text found</Text>
                              )}
                            </>
                          ) : needsOcr ? (
                            <TouchableOpacity
                              style={styles.runOcrButton}
                              onPress={() => handleRunOCR(index)}
                              disabled={isOcrProcessing}
                            >
                              <Text style={styles.runOcrButtonText}>
                                {isOcrProcessing ? 'Processing...' : 'Run OCR'}
                              </Text>
                            </TouchableOpacity>
                          ) : !ocrAvailable ? (
                            <Text style={styles.ocrUnavailable}>OCR unavailable</Text>
                          ) : null}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>

              {/* Summary stats */}
              {(rectificationSummary || ocrSummary) && (
                <View style={styles.cropsSummary}>
                  {rectificationSummary && (
                    <Text style={styles.cropsSummaryText}>
                      {rectificationSummary.succeeded} of {rectificationSummary.total} crops generated
                      {rectificationSummary.skipped > 0 && ` (${rectificationSummary.skipped} skipped)`}
                    </Text>
                  )}
                  {ocrSummary && (
                    <Text style={styles.cropsSummaryText}>
                      OCR: {ocrSummary.succeeded} succeeded, {ocrSummary.withTitles} with titles
                      {ocrSummary.dominantRotation !== undefined && ` (rotation: ${ocrSummary.dominantRotation}°)`}
                    </Text>
                  )}
                </View>
              )}
            </ScrollView>
          )}
        </View>
      )}

      {/* Detection info panel */}
      {selectedDetectionIndex !== null && detections[selectedDetectionIndex] && (
        <View style={styles.infoPanel}>
          <Text style={styles.infoPanelTitle}>
            Detection {selectedDetectionIndex + 1}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.infoRow}>
              <InfoItem label="Score" value={detections[selectedDetectionIndex].score.toFixed(3)} />
              <InfoItem label="Center" value={`(${detections[selectedDetectionIndex].cx.toFixed(0)}, ${detections[selectedDetectionIndex].cy.toFixed(0)})`} />
              <InfoItem label="Size" value={`${detections[selectedDetectionIndex].width.toFixed(0)} x ${detections[selectedDetectionIndex].height.toFixed(0)}`} />
              <InfoItem label="Angle" value={`${(detections[selectedDetectionIndex].angle * 180 / Math.PI).toFixed(1)}°`} />
              <InfoItem label="Class" value={detections[selectedDetectionIndex].className || `ID: ${detections[selectedDetectionIndex].classId}`} />
            </View>
          </ScrollView>
        </View>
      )}

      {/* Detection list */}
      <View style={styles.listContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {detections.map((detection, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.detectionChip,
                selectedDetectionIndex === index && styles.detectionChipSelected,
              ]}
              onPress={() => handleDetectionTap(index)}
            >
              <Text style={[
                styles.detectionChipText,
                selectedDetectionIndex === index && styles.detectionChipTextSelected,
              ]}>
                {index + 1}: {detection.score.toFixed(2)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

// Info item component
function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoItem}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 16,
  },
  errorBanner: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  errorText: {
    color: '#fff',
    fontSize: 13,
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 12,
    backgroundColor: '#1c1c1e',
  },
  backButton: {
    padding: 8,
  },
  backButtonText: {
    color: '#007AFF',
    fontSize: 16,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  detectionCount: {
    color: '#8e8e93',
    fontSize: 14,
  },
  imageContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  image: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  infoPanel: {
    backgroundColor: '#1c1c1e',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#38383a',
  },
  infoPanelTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
  },
  infoItem: {
    marginRight: 24,
  },
  infoLabel: {
    color: '#8e8e93',
    fontSize: 12,
    marginBottom: 4,
  },
  infoValue: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  listContainer: {
    backgroundColor: '#1c1c1e',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#38383a',
  },
  detectionChip: {
    backgroundColor: '#38383a',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    marginRight: 8,
  },
  detectionChipSelected: {
    backgroundColor: '#007AFF',
  },
  detectionChipText: {
    color: '#fff',
    fontSize: 14,
  },
  detectionChipTextSelected: {
    fontWeight: '600',
  },
  // Tab bar styles
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1c1c1e',
    borderBottomWidth: 1,
    borderBottomColor: '#38383a',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#007AFF',
  },
  tabText: {
    color: '#8e8e93',
    fontSize: 15,
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#007AFF',
  },
  // Crops view styles
  cropsContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  cropsScrollContent: {
    padding: 16,
  },
  noCropsContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  noCropsTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  noCropsMessage: {
    color: '#8e8e93',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  noCropsStats: {
    color: '#636366',
    fontSize: 12,
    textAlign: 'center',
  },
  shareAllButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignSelf: 'center',
    marginBottom: 16,
  },
  shareAllButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cropsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  cropCard: {
    width: '100%',
    height: 200,
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  cropCardSelected: {
    borderWidth: 2,
    borderColor: '#007AFF',
  },
  cropCardSkipped: {
    opacity: 0.5,
  },
  cropImage: {
    width: '100%',
    height: '100%',
  },
  cropOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  cropIndex: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  cropShareButton: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
  },
  cropShareButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  cropSkippedContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  cropSkippedIndex: {
    color: '#636366',
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  cropSkippedText: {
    color: '#8e8e93',
    fontSize: 14,
    fontWeight: '500',
  },
  cropSkippedReason: {
    color: '#636366',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  cropsSummary: {
    paddingTop: 8,
    alignItems: 'center',
  },
  cropsSummaryText: {
    color: '#8e8e93',
    fontSize: 13,
    marginBottom: 4,
  },
  // OCR styles
  cropCardContainer: {
    marginRight: 16,
    marginBottom: 16,
    width: (SCREEN_WIDTH - 48) / 2,
  },
  ocrBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(52, 199, 89, 0.9)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  ocrBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  ocrProcessingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ocrInfoContainer: {
    paddingTop: 8,
    paddingHorizontal: 4,
    minHeight: 44,
  },
  ocrTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 16,
  },
  ocrAuthor: {
    color: '#8e8e93',
    fontSize: 11,
    marginTop: 2,
  },
  ocrNoText: {
    color: '#636366',
    fontSize: 11,
    fontStyle: 'italic',
  },
  runOcrButton: {
    backgroundColor: '#38383a',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  runOcrButtonText: {
    color: '#007AFF',
    fontSize: 12,
    fontWeight: '500',
  },
  ocrUnavailable: {
    color: '#636366',
    fontSize: 11,
    fontStyle: 'italic',
  },
});
