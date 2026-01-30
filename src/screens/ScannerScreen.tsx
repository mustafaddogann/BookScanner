/**
 * ScannerScreen - Camera preview and capture
 *
 * Orientation handling:
 * - VisionCamera outputOrientation is set to "preview" (follows preview orientation)
 * - Device orientation changes are tracked internally for overlay math
 * - Orientation changes are debounced (300ms) to avoid rapid state updates
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  PhotoFile,
  Orientation,
} from 'react-native-vision-camera';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { runPipelineOnCapture } from '../services/pipelineService';
import { useAppStore } from '../store/useAppStore';
import { normalizeFileUri } from '../utils/frameGeo';

// Orientation debounce time in ms
const ORIENTATION_DEBOUNCE_MS = 300;

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Scanner'>;
type ScannerRouteProp = RouteProp<RootStackParamList, 'Scanner'>;

/**
 * Internal UI orientation type for overlay calculations.
 * This is separate from VisionCamera's OutputOrientation ('device' | 'preview').
 */
type UIOrientation = Orientation;

export function ScannerScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ScannerRouteProp>();
  const camera = useRef<Camera>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [scanMode, setScanMode] = useState<'shelf' | 'single'>('shelf');
  const [railExpanded, setRailExpanded] = useState(false);
  const [qualityMode, setQualityMode] = useState<'speed' | 'accuracy'>('accuracy');
  const [gridEnabled, setGridEnabled] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const { isProcessing, processingStage, error, setError } = useAppStore();
  const checklistStages = [
    'Detecting spines',
    'Rectifying',
    'Reading text',
    'Grouping books',
    'Extracting fields',
  ];

  // Internal UI orientation state for overlay calculations
  // This tracks the device orientation for UI/overlay purposes only.
  // VisionCamera outputOrientation is always "preview" (constant).
  const [uiOrientation, setUIOrientation] = useState<UIOrientation>('portrait');
  const orientationDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOrientationUpdate = useRef<number>(0);

  const importUri = route.params?.importUri;

  // Request camera permission on mount
  useEffect(() => {
    if (!hasPermission && !importUri) {
      requestPermission();
    }
  }, [hasPermission, requestPermission, importUri]);

  // Handle orientation change from VisionCamera callback (for internal UI tracking)
  // This is called by onOutputOrientationChanged and provides the device's physical orientation.
  // We use this for overlay calculations only - not for VisionCamera outputOrientation prop.
  const handleOrientationChange = useCallback((newOrientation: Orientation) => {
    const now = Date.now();

    // Skip if same as current
    if (newOrientation === uiOrientation) {
      return;
    }

    // Debounce rapid changes
    if (now - lastOrientationUpdate.current < ORIENTATION_DEBOUNCE_MS) {
      // Clear existing timer and set new one
      if (orientationDebounceTimer.current) {
        clearTimeout(orientationDebounceTimer.current);
      }
      orientationDebounceTimer.current = setTimeout(() => {
        handleOrientationChange(newOrientation);
      }, ORIENTATION_DEBOUNCE_MS);
      return;
    }

    // Apply the orientation change (for UI tracking only)
    lastOrientationUpdate.current = now;
    setUIOrientation(newOrientation);
    console.log(`[Scanner] UI orientation updated: ${newOrientation}`);
  }, [uiOrientation]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (orientationDebounceTimer.current) {
        clearTimeout(orientationDebounceTimer.current);
      }
    };
  }, []);

  // Handle capture
  const handleCapture = useCallback(async () => {
    if (!camera.current || isCapturing || isProcessing) return;

    setIsCapturing(true);
    setError(null);

    try {
      console.log(`[Scanner] Capturing photo... (ui orientation: ${uiOrientation})`);

      // Capture best quality still
      const photo: PhotoFile = await camera.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });

      console.log(`[Scanner] Photo captured: ${photo.path}`);
      console.log(`[Scanner] Dimensions: ${photo.width}x${photo.height}`);

      // Run pipeline
      const result = await runPipelineOnCapture(`file://${photo.path}`);

      console.log(`[Scanner] Pipeline complete. ${result.detections.length} detections`);

      // Navigate to results
      navigation.navigate('Results', { sessionId: result.session.sessionId });
    } catch (err: any) {
      console.error('[Scanner] Capture error:', err);
      Alert.alert('Capture Error', err.message);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, isProcessing, navigation, setError, uiOrientation]);

  const importRunRef = useRef<string | null>(null);

  useEffect(() => {
    if (!importUri) return;
    if (importRunRef.current === importUri) return;
    importRunRef.current = importUri;
    navigation.setParams({ importUri: undefined });

    const runImport = async () => {
      setIsCapturing(true);
      setError(null);
      try {
        const normalizedUri = importUri.startsWith('content://')
          ? importUri
          : normalizeFileUri(importUri);
        const result = await runPipelineOnCapture(normalizedUri);
        navigation.navigate('Results', { sessionId: result.session.sessionId });
      } catch (err: any) {
        setError(err.message || 'Import failed');
      } finally {
        setIsCapturing(false);
      }
    };

    runImport();
  }, [importUri, navigation, setError]);

  // Navigate to debug screen
  const handleDebug = useCallback(() => {
    navigation.navigate('Debug');
  }, [navigation]);

  const importAvailable = false;
  const handleImport = useCallback(() => {
    if (!importAvailable) return;
  }, [importAvailable]);

  const handleToggleRail = useCallback(() => {
    setRailExpanded((prev) => !prev);
  }, []);

  const mapProcessingStage = useCallback((stage: string | null): number => {
    if (!stage) return 0;
    const normalized = stage.toLowerCase();
    if (normalized.includes('rectification')) return 1;
    if (normalized.includes('ocr')) return 2;
    if (normalized.includes('grouping')) return 3;
    if (normalized.includes('metadata')) return 4;
    return 0;
  }, []);

  const [uiStageIndex, setUiStageIndex] = useState(0);

  useEffect(() => {
    if (!isCapturing && !isProcessing) {
      setUiStageIndex(0);
      return;
    }
    const mapped = mapProcessingStage(processingStage);
    setUiStageIndex((prev) => Math.max(prev, mapped));
  }, [isCapturing, isProcessing, processingStage, mapProcessingStage]);

  useEffect(() => {
    if (!isCapturing && !isProcessing) return undefined;
    if (processingStage) return undefined;

    const intervalId = setInterval(() => {
      setUiStageIndex((prev) => Math.min(prev + 1, checklistStages.length - 1));
    }, 800);

    return () => clearInterval(intervalId);
  }, [isCapturing, isProcessing, processingStage, checklistStages.length]);

  // Permission denied state
  if (!hasPermission && !importUri) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionText}>Camera permission required</Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // No device available
  if (!device && !importUri) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionText}>No camera device available</Text>
        </View>
      </View>
    );
  }

  // Camera stability: Keep camera ALWAYS active to avoid AVFoundation reconfiguration errors
  // Toggling isActive causes FigXPCUtilities err=-17281 and session restart issues
  // The processing overlay handles UI blocking - camera session should remain stable
  const isCameraActive = true;

  return (
    <View style={styles.container}>
      {!importUri && device && (
        <Camera
          ref={camera}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={isCameraActive}
          photo={true}
          enableZoomGesture={!isCapturing}
          outputOrientation="preview"
          onOutputOrientationChanged={handleOrientationChange}
        />
      )}

      {gridEnabled && (
        <View pointerEvents="none" style={styles.gridOverlay}>
          <View style={[styles.gridLineHorizontal, { top: '33.33%' }]} />
          <View style={[styles.gridLineHorizontal, { top: '66.66%' }]} />
          <View style={[styles.gridLineVertical, { left: '33.33%' }]} />
          <View style={[styles.gridLineVertical, { left: '66.66%' }]} />
        </View>
      )}

      {/* Processing overlay */}
      {(isCapturing || isProcessing) && (
        <View style={styles.processingOverlay}>
          <View style={styles.processingCard}>
            <Text style={styles.processingTitle}>Processing</Text>
            {checklistStages.map((stage, index) => {
              const isComplete = index < uiStageIndex;
              const isCurrent = index === uiStageIndex;
              return (
                <View key={stage} style={styles.processingRow}>
                  <Text
                    style={[
                      styles.processingMarker,
                      isComplete && styles.processingMarkerComplete,
                      isCurrent && styles.processingMarkerCurrent,
                    ]}
                  >
                    {isComplete ? '✓' : isCurrent ? '•' : '○'}
                  </Text>
                  <Text
                    style={[
                      styles.processingLabel,
                      isComplete && styles.processingLabelComplete,
                      isCurrent && styles.processingLabelCurrent,
                    ]}
                  >
                    {stage}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Error display */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Bottom control rail */}
      <View style={styles.bottomRail}>
        <View style={styles.railTopRow}>
          <View style={styles.modePill}>
            <TouchableOpacity
              style={[
                styles.modeOption,
                scanMode === 'shelf' && styles.modeOptionActive,
              ]}
              onPress={() => setScanMode('shelf')}
            >
              <Text
                style={[
                  styles.modeOptionText,
                  scanMode === 'shelf' && styles.modeOptionTextActive,
                ]}
              >
                Shelf
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeOption,
                scanMode === 'single' && styles.modeOptionActive,
              ]}
              onPress={() => setScanMode('single')}
            >
              <Text
                style={[
                  styles.modeOptionText,
                  scanMode === 'single' && styles.modeOptionTextActive,
                ]}
              >
                Single
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.railTopRight}>
            <TouchableOpacity
              style={styles.importButton}
              onPress={handleImport}
              disabled={!importAvailable}
            >
              <Text
                style={[
                  styles.importText,
                  !importAvailable && styles.importTextDisabled,
                ]}
              >
                Import
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.chevronButton} onPress={handleToggleRail}>
              <Text style={styles.chevronText}>{railExpanded ? '▾' : '▴'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.railMiddleRow}>
          <TouchableOpacity
            style={[
              styles.captureButton,
              (isCapturing || isProcessing) && styles.captureButtonDisabled,
            ]}
            onPress={handleCapture}
            disabled={isCapturing || isProcessing}
          >
            <View style={styles.captureButtonInner} />
          </TouchableOpacity>
          <Text style={styles.captureHint}>Tap to capture</Text>
        </View>

        {railExpanded && (
          <View style={styles.railExpanded}>
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Speed</Text>
              <View style={styles.toggleGroup}>
                <TouchableOpacity
                  style={[
                    styles.toggleOption,
                    qualityMode === 'speed' && styles.toggleOptionActive,
                  ]}
                  onPress={() => setQualityMode('speed')}
                >
                  <Text
                    style={[
                      styles.toggleOptionText,
                      qualityMode === 'speed' && styles.toggleOptionTextActive,
                    ]}
                  >
                    Speed
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.toggleOption,
                    qualityMode === 'accuracy' && styles.toggleOptionActive,
                  ]}
                  onPress={() => setQualityMode('accuracy')}
                >
                  <Text
                    style={[
                      styles.toggleOptionText,
                      qualityMode === 'accuracy' && styles.toggleOptionTextActive,
                    ]}
                  >
                    Accuracy
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Grid</Text>
              <TouchableOpacity
                style={[
                  styles.gridToggle,
                  gridEnabled && styles.gridToggleActive,
                ]}
                onPress={() => setGridEnabled((prev) => !prev)}
              >
                <Text
                  style={[
                    styles.gridToggleText,
                    gridEnabled && styles.gridToggleTextActive,
                  ]}
                >
                  {gridEnabled ? 'On' : 'Off'}
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.debugButton, styles.debugButtonCompact]}
              onPress={handleDebug}
              disabled={isCapturing || isProcessing}
            >
              <Text style={styles.debugButtonText}>Debug</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  permissionText: {
    color: '#fff',
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  permissionButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingCard: {
    backgroundColor: 'rgba(28, 28, 30, 0.95)',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    minWidth: 220,
  },
  processingTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  processingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  processingMarker: {
    color: '#636366',
    fontSize: 12,
    width: 18,
    textAlign: 'center',
  },
  processingMarkerComplete: {
    color: '#30D158',
  },
  processingMarkerCurrent: {
    color: '#007AFF',
  },
  processingLabel: {
    color: '#8e8e93',
    fontSize: 13,
  },
  processingLabelComplete: {
    color: '#fff',
  },
  processingLabelCurrent: {
    color: '#fff',
    fontWeight: '600',
  },
  errorBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 20,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(255, 59, 48, 0.9)',
    padding: 12,
    borderRadius: 8,
  },
  errorText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
  },
  gridOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  gridLineHorizontal: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  gridLineVertical: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  bottomRail: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 24 : 16,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  railTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modePill: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 16,
    padding: 2,
  },
  modeOption: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  modeOptionActive: {
    backgroundColor: '#007AFF',
  },
  modeOptionText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  modeOptionTextActive: {
    color: '#fff',
  },
  railTopRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  importButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  importText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  importTextDisabled: {
    color: '#636366',
  },
  chevronButton: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  chevronText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  railMiddleRow: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  debugButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
  },
  debugButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  debugButtonCompact: {
    alignSelf: 'flex-start',
  },
  captureButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureButtonDisabled: {
    opacity: 0.5,
  },
  captureButtonInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#fff',
  },
  captureHint: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 8,
  },
  railExpanded: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    paddingTop: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  toggleLabel: {
    color: '#8e8e93',
    fontSize: 12,
  },
  toggleGroup: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 12,
    padding: 2,
  },
  toggleOption: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  toggleOptionActive: {
    backgroundColor: '#007AFF',
  },
  toggleOptionText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  toggleOptionTextActive: {
    color: '#fff',
  },
  gridToggle: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  gridToggleActive: {
    backgroundColor: '#007AFF',
  },
  gridToggleText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  gridToggleTextActive: {
    color: '#fff',
  },
});
