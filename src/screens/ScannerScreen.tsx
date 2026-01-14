/**
 * ScannerScreen - Camera preview and capture
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
} from 'react-native-vision-camera';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { createSessionFromCapture } from '../services/imageService';
import { runPipelineOnCapture } from '../services/pipelineService';
import { useAppStore } from '../store/useAppStore';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Scanner'>;

export function ScannerScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const camera = useRef<Camera>(null);
  const [isCapturing, setIsCapturing] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const { isProcessing, processingStage, error, setError } = useAppStore();

  // Request camera permission on mount
  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Handle capture
  const handleCapture = useCallback(async () => {
    if (!camera.current || isCapturing || isProcessing) return;

    setIsCapturing(true);
    setError(null);

    try {
      console.log('[Scanner] Capturing photo...');

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
  }, [isCapturing, isProcessing, navigation, setError]);

  // Navigate to debug screen
  const handleDebug = useCallback(() => {
    navigation.navigate('Debug');
  }, [navigation]);

  // Permission denied state
  if (!hasPermission) {
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
  if (!device) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionText}>No camera device available</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
        enableZoomGesture={true}
      />

      {/* Processing overlay */}
      {(isCapturing || isProcessing) && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color="#ffffff" />
          <Text style={styles.processingText}>
            {processingStage || 'Processing...'}
          </Text>
        </View>
      )}

      {/* Error display */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Controls */}
      <View style={styles.controls}>
        {/* Debug button */}
        <TouchableOpacity
          style={styles.debugButton}
          onPress={handleDebug}
          disabled={isCapturing || isProcessing}
        >
          <Text style={styles.debugButtonText}>Debug</Text>
        </TouchableOpacity>

        {/* Capture button */}
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

        {/* Placeholder for symmetry */}
        <View style={styles.placeholder} />
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
  processingText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 16,
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
  controls: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 20,
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
  placeholder: {
    width: 70,
  },
});
