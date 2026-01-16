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
} from 'react-native';
import Svg, { Polygon, Circle, Text as SvgText } from 'react-native-svg';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, OBBDetection, OBBCorners, ScreenMapping, SerializedFrameGeo } from '../types';
import { obbToCorners, mapCornersToScreen, calculateScreenMapping } from '../utils/letterbox';
import { useAppStore } from '../store/useAppStore';
import { readDebugManifest, getSessionDir } from '../services/debugArtifacts';

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
  } = useAppStore();

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [containerLayout, setContainerLayout] = useState<{ width: number; height: number } | null>(null);
  const [screenMapping, setScreenMapping] = useState<ScreenMapping | null>(null);
  const [loading, setLoading] = useState(true);

  const [loadError, setLoadError] = useState<string | null>(null);

  // Load session data with robust guards
  useEffect(() => {
    async function loadSession() {
      try {
        const sessionDir = getSessionDir(sessionId);
        const manifest = await readDebugManifest(sessionId);

        // Priority order for display image:
        // 1. input_normalized.jpg (EXIF-corrected, matches detection coordinates)
        // 2. original.jpg (raw camera output)
        // 3. original.png (alternative format)
        let foundImageUri: string | null = null;
        const normalizedPath = `${sessionDir}/input_normalized.jpg`;
        const jpgPath = `${sessionDir}/original.jpg`;
        const pngPath = `${sessionDir}/original.png`;

        // Check which image exists (prefer normalized)
        try {
          const { default: RNFS } = await import('react-native-fs');
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
        } catch {
          // Fall back to normalized path
          foundImageUri = `file://${normalizedPath}`;
        }

        setImageUri(foundImageUri);

        // SINGLE SOURCE OF TRUTH: Use FrameGeo dimensions from manifest
        // This ensures overlay coordinates match exactly what the pipeline used
        const frameGeo = manifest?.frameGeo as SerializedFrameGeo | undefined;

        if (frameGeo && typeof frameGeo.pixelW === 'number' && typeof frameGeo.pixelH === 'number') {
          // Use FrameGeo as authoritative source
          console.log(`[Results] Using FrameGeo dimensions: ${frameGeo.pixelW}x${frameGeo.pixelH}`);
          console.log(`[Results] FrameGeo letterbox: scale=${frameGeo.letterbox?.scale?.toFixed(4)}, pad=(${frameGeo.letterbox?.padX}, ${frameGeo.letterbox?.padY})`);
          setImageDimensions({
            width: frameGeo.pixelW,
            height: frameGeo.pixelH,
          });

          // Verify with Image.getSize for debugging (but don't use the result)
          if (foundImageUri) {
            try {
              const { Image: RNImage } = await import('react-native');
              RNImage.getSize(
                foundImageUri,
                (w, h) => {
                  if (w !== frameGeo.pixelW || h !== frameGeo.pixelH) {
                    console.warn(`[Results] WARNING: Image.getSize returned ${w}x${h}, but FrameGeo says ${frameGeo.pixelW}x${frameGeo.pixelH}`);
                    console.warn('[Results] Using FrameGeo dimensions (single source of truth)');
                  } else {
                    console.log('[Results] Image.getSize matches FrameGeo - dimensions verified');
                  }
                },
                () => { /* ignore errors in verification */ }
              );
            } catch { /* ignore */ }
          }
        } else if (manifest && manifest.imageMeta && typeof manifest.imageMeta.width === 'number') {
          // Fallback to imageMeta if FrameGeo not available (legacy manifests)
          console.warn('[Results] FrameGeo not in manifest, using imageMeta (legacy fallback)');
          setImageDimensions({
            width: manifest.imageMeta.width,
            height: manifest.imageMeta.height,
          });
        } else {
          // Last resort: Try to get dimensions from Image.getSize
          console.warn('[Results] No dimension source in manifest, using Image.getSize fallback');
          if (foundImageUri) {
            try {
              const { Image: RNImage } = await import('react-native');
              await new Promise<void>((resolve, reject) => {
                RNImage.getSize(
                  foundImageUri!,
                  (w, h) => {
                    console.warn(`[Results] Image.getSize returned ${w}x${h} - coordinates may not match!`);
                    setImageDimensions({ width: w, height: h });
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
        }

        // Guard: Check if detections exist and update store
        // NOTE: detections should be FILTERED (post NMS + geometric filters)
        // Diagnostic decode results are saved to diag_decode.json but NOT displayed
        if (detections.length === 0 && manifest) {
          const manifestDetections = manifest.detectionsOriginal || manifest.detectionsFrameSpace || [];
          console.log(`[Results] Store empty, loading ${manifestDetections.length} filtered detections from manifest`);
          if (Array.isArray(manifestDetections)) {
            useAppStore.getState().setDetections(manifestDetections);
          }
        } else {
          console.log(`[Results] Using ${detections.length} filtered detections from store`);
        }

        // If no manifest at all, show warning but don't crash
        if (!manifest) {
          setLoadError('Session manifest not found. Results may be incomplete.');
        }
      } catch (error: any) {
        console.error('[Results] Failed to load session:', error);
        setLoadError(`Failed to load session: ${error.message}`);
      } finally {
        setLoading(false);
      }
    }

    loadSession();
  }, [sessionId]);

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

      {/* Image container with overlay */}
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
});
