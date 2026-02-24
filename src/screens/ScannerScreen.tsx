/**
 * ScannerScreen - Camera capture with cinematic processing
 *
 * UX Flow:
 * 1. Camera preview with minimal chrome
 * 2. Single prominent capture button (no distracting options until needed)
 * 3. On capture: cinematic processing overlay with real stage progress
 * 4. Auto-navigate to Results on completion
 *
 * Key UX decisions:
 * - Mode selector (shelf/single) tucked in expandable rail to reduce visual noise
 * - Capture button is the hero element — everything else is secondary
 * - Processing stages show meaningful progress, not just a spinner
 * - Error states are non-blocking where possible
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  Image,
  Platform,
  Animated,
  Dimensions,
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
import { setLastScannedImageUri } from '../services/autoExportService';
import { useAppStore } from '../store/useAppStore';
import { normalizeFileUri } from '../utils/frameGeo';
import { colors, fonts, spacing, radii, shadows } from '../theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const ORIENTATION_DEBOUNCE_MS = 300;

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Scanner'>;
type ScannerRouteProp = RouteProp<RootStackParamList, 'Scanner'>;
type UIOrientation = Orientation;

const STAGES = [
  { key: 'detect', label: 'Detecting spines', icon: '\u{1F50D}' },
  { key: 'rectify', label: 'Cropping & aligning', icon: '\u{1F4D0}' },
  { key: 'ocr', label: 'Reading text', icon: '\u{1F4D6}' },
  { key: 'group', label: 'Identifying books', icon: '\u{1F4DA}' },
  { key: 'resolve', label: 'Matching metadata', icon: '\u2728' },
];

export function ScannerScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ScannerRouteProp>();
  const camera = useRef<Camera>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedImageUri, setCapturedImageUri] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState<'shelf' | 'single'>('shelf');
  const [railExpanded, setRailExpanded] = useState(false);
  const [qualityMode, setQualityMode] = useState<'speed' | 'accuracy'>('accuracy');
  const [gridEnabled, setGridEnabled] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const { isProcessing, processingStage, error, setError } = useAppStore();

  // === Animations ===

  // Capture button breathing glow
  const glowAnim = useRef(new Animated.Value(0.1)).current;
  useEffect(() => {
    if (isCapturing || isProcessing) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 0.35, duration: 2000, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0.1, duration: 2000, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glowAnim, isCapturing, isProcessing]);

  // Capture press spring
  const captureScale = useRef(new Animated.Value(1)).current;
  const handleCaptureIn = useCallback(() => {
    Animated.spring(captureScale, { toValue: 0.92, useNativeDriver: true, tension: 120, friction: 8 }).start();
  }, [captureScale]);
  const handleCaptureOut = useCallback(() => {
    Animated.spring(captureScale, { toValue: 1, useNativeDriver: true, tension: 80, friction: 6 }).start();
  }, [captureScale]);

  // Processing overlay fade
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isCapturing || isProcessing) {
      Animated.timing(overlayOpacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    } else {
      Animated.timing(overlayOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();
    }
  }, [isCapturing, isProcessing, overlayOpacity]);

  // Stage progress bars
  const progressAnims = useRef(STAGES.map(() => new Animated.Value(0))).current;
  const stageOpacity = useRef(STAGES.map(() => new Animated.Value(0.4))).current;

  // Orientation
  const [uiOrientation, setUIOrientation] = useState<UIOrientation>('portrait');
  const orientationDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOrientationUpdate = useRef<number>(0);

  const importUri = route.params?.importUri;

  useEffect(() => {
    if (!hasPermission && !importUri) {
      requestPermission();
    }
  }, [hasPermission, requestPermission, importUri]);

  const handleOrientationChange = useCallback((newOrientation: Orientation) => {
    const now = Date.now();
    if (newOrientation === uiOrientation) return;
    if (now - lastOrientationUpdate.current < ORIENTATION_DEBOUNCE_MS) {
      if (orientationDebounceTimer.current) clearTimeout(orientationDebounceTimer.current);
      orientationDebounceTimer.current = setTimeout(() => handleOrientationChange(newOrientation), ORIENTATION_DEBOUNCE_MS);
      return;
    }
    lastOrientationUpdate.current = now;
    setUIOrientation(newOrientation);
  }, [uiOrientation]);

  useEffect(() => {
    return () => {
      if (orientationDebounceTimer.current) clearTimeout(orientationDebounceTimer.current);
    };
  }, []);

  // === Stage mapping ===
  const [uiStageIndex, setUiStageIndex] = useState(0);

  const mapProcessingStage = useCallback((stage: string | null): number => {
    if (!stage) return 0;
    const normalized = stage.toLowerCase();
    if (normalized.includes('rectification')) return 1;
    if (normalized.includes('ocr')) return 2;
    if (normalized.includes('grouping')) return 3;
    if (normalized.includes('metadata')) return 4;
    return 0;
  }, []);

  useEffect(() => {
    if (!isCapturing && !isProcessing) {
      setUiStageIndex(0);
      progressAnims.forEach((a) => a.setValue(0));
      stageOpacity.forEach((a) => a.setValue(0.4));
      return;
    }
    const mapped = mapProcessingStage(processingStage);
    setUiStageIndex((prev) => Math.max(prev, mapped));
  }, [isCapturing, isProcessing, processingStage, mapProcessingStage, progressAnims, stageOpacity]);

  useEffect(() => {
    progressAnims.forEach((anim, idx) => {
      if (idx < uiStageIndex) {
        // Completed stages
        Animated.timing(anim, { toValue: 1, duration: 300, useNativeDriver: false }).start();
        Animated.timing(stageOpacity[idx], { toValue: 0.5, duration: 300, useNativeDriver: false }).start();
      } else if (idx === uiStageIndex && (isCapturing || isProcessing)) {
        // Current stage - animate to partial fill
        Animated.timing(anim, { toValue: 0.65, duration: 1000, useNativeDriver: false }).start();
        Animated.timing(stageOpacity[idx], { toValue: 1, duration: 200, useNativeDriver: false }).start();
      }
    });
  }, [uiStageIndex, isCapturing, isProcessing, progressAnims, stageOpacity]);

  // Fallback stage advancement when no explicit stage signal
  useEffect(() => {
    if (!isCapturing && !isProcessing) return undefined;
    if (processingStage) return undefined;
    const intervalId = setInterval(() => {
      setUiStageIndex((prev) => Math.min(prev + 1, STAGES.length - 1));
    }, 900);
    return () => clearInterval(intervalId);
  }, [isCapturing, isProcessing, processingStage]);

  // === Handlers ===

  const handleCapture = useCallback(async () => {
    if (!camera.current || isCapturing || isProcessing) return;
    setIsCapturing(true);
    setError(null);
    try {
      const photo: PhotoFile = await camera.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });
      const imageUri = `file://${photo.path}`;
      setCapturedImageUri(imageUri);
      const result = await runPipelineOnCapture(imageUri);
      setLastScannedImageUri(imageUri);
      navigation.navigate('Results', { sessionId: result.session.sessionId });
    } catch (err: unknown) {
      setCapturedImageUri(null);
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert('Capture Error', message);
    } finally {
      setIsCapturing(false);
      setCapturedImageUri(null);
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
        setCapturedImageUri(normalizedUri);
        const result = await runPipelineOnCapture(normalizedUri);
        setLastScannedImageUri(normalizedUri);
        navigation.navigate('Results', { sessionId: result.session.sessionId });
      } catch (err: unknown) {
        setCapturedImageUri(null);
        const message = err instanceof Error ? err.message : String(err);
        setError(message || 'Import failed');
      } finally {
        setIsCapturing(false);
        setCapturedImageUri(null);
      }
    };

    runImport();
  }, [importUri, navigation, setError]);

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

  // === Permission states ===

  if (!hasPermission && !importUri) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <View style={styles.permissionIconBg}>
            <Text style={styles.permissionIcon}>{'\u{1F4F7}'}</Text>
          </View>
          <Text style={styles.permissionTitle}>Camera Access</Text>
          <Text style={styles.permissionText}>
            We need camera access to scan your bookshelves.
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Allow Camera</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!device && !importUri) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionText}>No camera device available</Text>
        </View>
      </View>
    );
  }

  // === Main render ===

  return (
    <View style={styles.container}>
      {/* Camera / captured image */}
      {capturedImageUri ? (
        <Image
          source={{ uri: capturedImageUri }}
          style={[StyleSheet.absoluteFill, { resizeMode: 'contain' }]}
          onError={() => setCapturedImageUri(null)}
        />
      ) : (
        !importUri && device && (
          <Camera
            ref={camera}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={true}
            photo={true}
            enableZoomGesture={!isCapturing}
            outputOrientation="preview"
            onOutputOrientationChanged={handleOrientationChange}
          />
        )
      )}

      {/* Grid overlay */}
      {gridEnabled && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={[styles.gridLine, styles.gridHorizontal, { top: '33.33%' }]} />
          <View style={[styles.gridLine, styles.gridHorizontal, { top: '66.66%' }]} />
          <View style={[styles.gridLine, styles.gridVertical, { left: '33.33%' }]} />
          <View style={[styles.gridLine, styles.gridVertical, { left: '66.66%' }]} />
        </View>
      )}

      {/* Processing overlay — cinematic stages */}
      <Animated.View
        style={[styles.processingOverlay, { opacity: overlayOpacity }]}
        pointerEvents={isCapturing || isProcessing ? 'auto' : 'none'}
      >
        <View style={styles.processingContent}>
          <Text style={styles.processingTitle}>Analyzing your shelf</Text>
          <Text style={styles.processingSubtitle}>This takes a few seconds</Text>

          <View style={styles.stagesList}>
            {STAGES.map((stage, index) => {
              const isComplete = index < uiStageIndex;
              const isCurrent = index === uiStageIndex && (isCapturing || isProcessing);
              return (
                <Animated.View
                  key={stage.key}
                  style={[styles.stageRow, { opacity: stageOpacity[index] }]}
                >
                  <View style={styles.stageLeft}>
                    <Text style={[
                      styles.stageIcon,
                      isComplete && styles.stageIconComplete,
                    ]}>
                      {isComplete ? '\u2713' : stage.icon}
                    </Text>
                    <Text style={[
                      styles.stageLabel,
                      isComplete && styles.stageLabelComplete,
                      isCurrent && styles.stageLabelCurrent,
                    ]}>
                      {stage.label}
                    </Text>
                  </View>
                  <View style={styles.stageBarBg}>
                    <Animated.View
                      style={[
                        styles.stageBarFill,
                        isComplete && styles.stageBarComplete,
                        {
                          width: progressAnims[index].interpolate({
                            inputRange: [0, 1],
                            outputRange: ['0%', '100%'],
                          }),
                        },
                      ]}
                    />
                  </View>
                </Animated.View>
              );
            })}
          </View>
        </View>
      </Animated.View>

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Text style={styles.errorDismiss}>{'\u2715'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom controls — minimal when not expanded */}
      {!isCapturing && !isProcessing && (
        <View style={styles.bottomControls}>
          {/* Mode + options row */}
          <View style={styles.controlsTopRow}>
            <View style={styles.modePill}>
              <TouchableOpacity
                style={[styles.modeOption, scanMode === 'shelf' && styles.modeOptionActive]}
                onPress={() => setScanMode('shelf')}
              >
                <Text style={[styles.modeText, scanMode === 'shelf' && styles.modeTextActive]}>Shelf</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeOption, scanMode === 'single' && styles.modeOptionActive]}
                onPress={() => setScanMode('single')}
              >
                <Text style={[styles.modeText, scanMode === 'single' && styles.modeTextActive]}>Single</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.optionsButton}
              onPress={handleToggleRail}
            >
              <Text style={styles.optionsIcon}>
                {railExpanded ? '\u25BE' : '\u2699'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Capture button — the hero */}
          <View style={styles.captureRow}>
            <Animated.View style={[
              { transform: [{ scale: captureScale }] },
              { shadowOpacity: glowAnim, shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 }, shadowRadius: 24 },
            ]}>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={handleCapture}
                onPressIn={handleCaptureIn}
                onPressOut={handleCaptureOut}
                activeOpacity={1}
              >
                <View style={styles.captureButtonInner} />
              </TouchableOpacity>
            </Animated.View>
          </View>

          {/* Expanded options rail */}
          {railExpanded && (
            <View style={styles.expandedRail}>
              <View style={styles.railDivider} />

              <View style={styles.optionRow}>
                <Text style={styles.optionLabel}>Quality</Text>
                <View style={styles.optionPill}>
                  <TouchableOpacity
                    style={[styles.optionChoice, qualityMode === 'speed' && styles.optionChoiceActive]}
                    onPress={() => setQualityMode('speed')}
                  >
                    <Text style={[styles.optionChoiceText, qualityMode === 'speed' && styles.optionChoiceTextActive]}>Speed</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.optionChoice, qualityMode === 'accuracy' && styles.optionChoiceActive]}
                    onPress={() => setQualityMode('accuracy')}
                  >
                    <Text style={[styles.optionChoiceText, qualityMode === 'accuracy' && styles.optionChoiceTextActive]}>Accuracy</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.optionRow}>
                <Text style={styles.optionLabel}>Grid</Text>
                <TouchableOpacity
                  style={[styles.toggleChip, gridEnabled && styles.toggleChipActive]}
                  onPress={() => setGridEnabled((prev) => !prev)}
                >
                  <Text style={[styles.toggleChipText, gridEnabled && styles.toggleChipTextActive]}>
                    {gridEnabled ? 'On' : 'Off'}
                  </Text>
                </TouchableOpacity>
              </View>

              {__DEV__ && (
                <TouchableOpacity style={styles.debugLink} onPress={handleDebug}>
                  <Text style={styles.debugLinkText}>Debug tools</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },

  // Permission
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxxl,
  },
  permissionIconBg: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  permissionIcon: {
    fontSize: 32,
  },
  permissionTitle: {
    color: colors.textPrimary,
    fontSize: 22,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.sm,
  },
  permissionText: {
    color: colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: spacing.xxl,
    lineHeight: 22,
  },
  permissionButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xxxl,
    paddingVertical: 14,
    borderRadius: radii.xl,
    ...shadows.glow,
  },
  permissionButtonText: {
    color: colors.bgDeep,
    fontSize: 16,
    fontWeight: '700',
  },

  // Grid
  gridLine: {
    position: 'absolute',
    backgroundColor: 'rgba(212, 168, 83, 0.06)',
  },
  gridHorizontal: {
    left: 0,
    right: 0,
    height: 1,
  },
  gridVertical: {
    top: 0,
    bottom: 0,
    width: 1,
  },

  // Processing overlay
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(12, 10, 9, 0.88)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingContent: {
    width: SCREEN_WIDTH - 64,
    maxWidth: 320,
  },
  processingTitle: {
    color: colors.textPrimary,
    fontSize: 22,
    fontFamily: fonts.display.semiBold,
    textAlign: 'center',
    marginBottom: 4,
  },
  processingSubtitle: {
    color: colors.textTertiary,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: spacing.xxxl,
  },
  stagesList: {
    gap: 16,
  },
  stageRow: {
    gap: 6,
  },
  stageLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stageIcon: {
    fontSize: 14,
    width: 20,
    textAlign: 'center',
  },
  stageIconComplete: {
    color: colors.verified,
  },
  stageLabel: {
    color: colors.textTertiary,
    fontSize: 14,
    fontWeight: '500',
  },
  stageLabelComplete: {
    color: colors.textSecondary,
  },
  stageLabelCurrent: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  stageBarBg: {
    height: 3,
    backgroundColor: colors.bgNested,
    borderRadius: 2,
    marginLeft: 28,
    overflow: 'hidden',
  },
  stageBarFill: {
    height: 3,
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  stageBarComplete: {
    backgroundColor: colors.verified,
  },

  // Error
  errorBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 60,
    left: spacing.xxl,
    right: spacing.xxl,
    backgroundColor: 'rgba(199, 92, 92, 0.9)',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shadows.card,
  },
  errorText: {
    color: colors.textPrimary,
    fontSize: 13,
    flex: 1,
    marginRight: spacing.sm,
  },
  errorDismiss: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    padding: 4,
  },

  // Bottom controls
  bottomControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    backgroundColor: colors.glassBg,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  controlsTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg,
  },
  modePill: {
    flexDirection: 'row',
    backgroundColor: 'rgba(245, 240, 232, 0.08)',
    borderRadius: radii.pill,
    padding: 3,
  },
  modeOption: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: radii.pill,
  },
  modeOptionActive: {
    backgroundColor: colors.primary,
  },
  modeText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  modeTextActive: {
    color: colors.bgDeep,
  },
  optionsButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(245, 240, 232, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  optionsIcon: {
    color: colors.textSecondary,
    fontSize: 16,
  },

  // Capture button
  captureRow: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  captureButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  captureButtonInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.textPrimary,
  },

  // Expanded rail
  expandedRail: {
    marginTop: spacing.md,
  },
  railDivider: {
    height: 1,
    backgroundColor: colors.separator,
    marginBottom: spacing.lg,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  optionLabel: {
    color: colors.textSecondary,
    fontSize: 13,
  },
  optionPill: {
    flexDirection: 'row',
    backgroundColor: 'rgba(245, 240, 232, 0.08)',
    borderRadius: radii.pill,
    padding: 2,
  },
  optionChoice: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.pill,
  },
  optionChoiceActive: {
    backgroundColor: colors.primary,
  },
  optionChoiceText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  optionChoiceTextActive: {
    color: colors.bgDeep,
  },
  toggleChip: {
    backgroundColor: 'rgba(245, 240, 232, 0.08)',
    borderRadius: radii.pill,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  toggleChipActive: {
    backgroundColor: colors.primary,
  },
  toggleChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  toggleChipTextActive: {
    color: colors.bgDeep,
  },
  debugLink: {
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  debugLinkText: {
    color: colors.textMuted,
    fontSize: 12,
    textDecorationLine: 'underline',
  },
});
