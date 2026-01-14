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
import type { RootStackParamList, OBBDetection, OBBCorners, ScreenMapping } from '../types';
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

  // Load session data
  useEffect(() => {
    async function loadSession() {
      try {
        const manifest = await readDebugManifest(sessionId);
        if (manifest) {
          const sessionDir = getSessionDir(sessionId);
          setImageUri(`file://${sessionDir}/original.jpg`);
          setImageDimensions({
            width: manifest.imageMeta.width,
            height: manifest.imageMeta.height,
          });

          // Update store with detections if not already set
          if (detections.length === 0) {
            useAppStore.getState().setDetections(manifest.detectionsOriginal);
          }
        }
      } catch (error) {
        console.error('[Results] Failed to load session:', error);
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
  const getPolygonPoints = useCallback((obb: OBBDetection): string => {
    if (!screenMapping) return '';

    const corners = obbToCorners(obb);
    const screenCorners = mapCornersToScreen(corners, screenMapping);

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

  return (
    <View style={styles.container}>
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

        {/* SVG Overlay */}
        {screenMapping && (
          <Svg style={StyleSheet.absoluteFill}>
            {detections.map((detection, index) => {
              const isSelected = selectedDetectionIndex === index;
              const center = getScreenCenter(detection);

              return (
                <React.Fragment key={index}>
                  {/* OBB polygon */}
                  <Polygon
                    points={getPolygonPoints(detection)}
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
