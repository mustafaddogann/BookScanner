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
  Platform,
  Animated,
  ActivityIndicator,
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
import { runPipelineBackground } from '../services/pipelineService';
import { useAppStore } from '../store/useAppStore';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';
import { normalizeFileUri } from '../utils/frameGeo';
import { colors, fonts, spacing, radii, shadows } from '../theme';

const ORIENTATION_DEBOUNCE_MS = 300;

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Scanner'>;
type ScannerRouteProp = RouteProp<RootStackParamList, 'Scanner'>;
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

  const { error, setError } = useAppStore();
  const backgroundActiveCount = useBackgroundScanStore(
    (s) => Object.keys(s.scans).length
  );
  const captureDisabled = backgroundActiveCount >= 3;

  // === Animations ===

  // Shutter flash overlay
  const flashOpacity = useRef(new Animated.Value(0)).current;

  // Capture button breathing glow
  const glowAnim = useRef(new Animated.Value(0.1)).current;
  useEffect(() => {
    if (isCapturing) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 0.35, duration: 2000, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0.1, duration: 2000, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glowAnim, isCapturing]);

  // Capture press spring (JS driver to match glowAnim on same view tree)
  const captureScale = useRef(new Animated.Value(1)).current;
  const handleCaptureIn = useCallback(() => {
    Animated.spring(captureScale, { toValue: 0.92, useNativeDriver: false, tension: 120, friction: 8 }).start();
  }, [captureScale]);
  const handleCaptureOut = useCallback(() => {
    Animated.spring(captureScale, { toValue: 1, useNativeDriver: false, tension: 80, friction: 6 }).start();
  }, [captureScale]);

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

  // === Handlers ===

  const handleCapture = useCallback(async () => {
    if (!camera.current || isCapturing || captureDisabled) return;

    try {
      setIsCapturing(true);
      const photo: PhotoFile = await camera.current.takePhoto({
        flash: 'off',
        enableShutterSound: true,
      });
      const imageUri = `file://${photo.path}`;

      // Shutter flash feedback
      flashOpacity.setValue(1);
      Animated.timing(flashOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start();

      // Fire-and-forget background scan
      runPipelineBackground(imageUri).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        Alert.alert('Background Scan', message);
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      Alert.alert('Capture Error', message);
    } finally {
      setIsCapturing(false);
    }
  }, [isCapturing, captureDisabled, flashOpacity]);

  const importRunRef = useRef<string | null>(null);

  useEffect(() => {
    if (!importUri) return;
    if (importRunRef.current === importUri) return;
    importRunRef.current = importUri;
    navigation.setParams({ importUri: undefined });

    const normalizedUri = importUri.startsWith('content://')
      ? importUri
      : normalizeFileUri(importUri);

    runPipelineBackground(normalizedUri).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Import failed');
    });
  }, [importUri, navigation, setError]);

  const handleDebug = useCallback(() => {
    navigation.navigate('Debug');
  }, [navigation]);

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
      {/* Camera */}
      {!importUri && device && (
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
      )}

      {/* Shutter flash overlay */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: '#FFFFFF', opacity: flashOpacity }]}
      />

      {/* Grid overlay */}
      {gridEnabled && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={[styles.gridLine, styles.gridHorizontal, { top: '33.33%' }]} />
          <View style={[styles.gridLine, styles.gridHorizontal, { top: '66.66%' }]} />
          <View style={[styles.gridLine, styles.gridVertical, { left: '33.33%' }]} />
          <View style={[styles.gridLine, styles.gridVertical, { left: '66.66%' }]} />
        </View>
      )}

      {/* Background scan indicator */}
      {backgroundActiveCount > 0 && (
        <View style={styles.bgIndicator}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.bgIndicatorText}>
            Processing {backgroundActiveCount} scan{backgroundActiveCount > 1 ? 's' : ''}...
          </Text>
        </View>
      )}

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
      {!isCapturing && (
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
              { transform: [{ scale: captureScale }], opacity: captureDisabled ? 0.4 : 1 },
              { shadowOpacity: glowAnim, shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 }, shadowRadius: 24 },
            ]}>
              <TouchableOpacity
                style={styles.captureButton}
                onPress={handleCapture}
                onPressIn={handleCaptureIn}
                onPressOut={handleCaptureOut}
                activeOpacity={1}
                disabled={captureDisabled}
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

  // Background indicator
  bgIndicator: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 36,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(12, 10, 9, 0.8)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
  },
  bgIndicatorText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
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
