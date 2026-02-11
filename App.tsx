/**
 * BookScanner - Main Application Entry Point
 *
 * Bare React Native + TypeScript app for book spine detection
 * using YOLOv8 OBB (Oriented Bounding Boxes)
 */

import React, { useEffect, useCallback } from 'react';
import {
  StatusBar,
  LogBox,
  NativeModules,
  Platform,
  Text,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ScannerScreen, ResultsScreen, DebugScreen, SettingsScreen, TabsScreen, DiagnosticsScreen } from './src/screens';
import { useAppStore } from './src/store/useAppStore';
import { warmupModel } from './src/services/inferenceService';
import {
  checkRescanStatus,
  getLastScannedImageUri,
  getServerUrl,
  clearLastScannedImageUri,
  downloadScanImageFromServer,
} from './src/services/autoExportService';
import RNFS from 'react-native-fs';
import { useDebugStore } from './src/store/useDebugStore';
import type { RootStackParamList } from './src/types';

// Navigation ref for programmatic navigation from outside components
const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Track if startup rescan check has been done
let startupRescanDone = false;

// Suppress specific warnings in development
LogBox.ignoreLogs([
  'Non-serializable values were found in the navigation state',
]);

// Debug: Log native modules at startup (dev only)
if (__DEV__) {
  console.log('[App] Platform:', Platform.OS);
  console.log('[App] Native modules available:', Object.keys(NativeModules).join(', '));
  // Check specifically for PushNotificationManager (should NOT be present)
  const hasPushNotification = 'PushNotificationManager' in NativeModules;
  console.log('[App] PushNotificationManager linked:', hasPushNotification);
}

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Check for pending rescan signal on app startup.
 * Called when NavigationContainer is ready.
 * If Claude has fixed issues and the server has a rescan signal,
 * automatically navigate to Scanner to rescan the last image.
 */
async function checkStartupRescan(): Promise<void> {
  // Only run once per app launch
  if (startupRescanDone) {
    return;
  }
  startupRescanDone = true;

  try {
    // Check if auto-retry is enabled
    const autoRetryEnabled = useDebugStore.getState().autoRetryEnabled;
    console.log('[App] Startup rescan check - autoRetryEnabled:', autoRetryEnabled);
    if (!autoRetryEnabled) {
      console.log('[App] Auto-retry disabled, skipping startup rescan check');
      return;
    }

    // Check if server URL is configured
    const serverUrl = getServerUrl();
    console.log('[App] Startup rescan check - serverUrl:', serverUrl);
    if (!serverUrl) {
      console.log('[App] No server URL configured, skipping startup rescan check');
      return;
    }

    // First, check if there's a pending rescan signal
    console.log('[App] Checking server for pending rescan signal...');
    const status = await checkRescanStatus();
    console.log('[App] Rescan status:', JSON.stringify(status));

    if (!status.rescan || !status.auto_retry) {
      console.log('[App] No pending rescan signal');
      return;
    }

    // Found a rescan signal - now get the image
    console.log('[App] Found pending rescan signal, getting image...');
    const sessionId = status.session_id;

    // Try to get stored image URI
    let finalImageUri = getLastScannedImageUri();
    console.log('[App] Stored image URI:', finalImageUri ? 'exists' : 'null');

    // Check if local file exists
    let localFileExists = false;
    if (finalImageUri) {
      const filePath = finalImageUri.replace('file://', '');
      localFileExists = await RNFS.exists(filePath);
      console.log('[App] Local file exists:', localFileExists);
    }

    // If local file doesn't exist, try to download from server
    if (!localFileExists && sessionId) {
      console.log('[App] Local file missing, downloading from server...');
      const downloadedUri = await downloadScanImageFromServer(sessionId);
      if (downloadedUri) {
        console.log('[App] Downloaded image from server');
        finalImageUri = downloadedUri;
      } else {
        console.log('[App] Could not download image from server');
        finalImageUri = null;
      }
    }

    // If we still don't have an image, clear signal and abort
    if (!finalImageUri) {
      console.log('[App] No image available for rescan, clearing signal');
      clearLastScannedImageUri();
      try {
        const baseUrl = serverUrl.replace(/\/upload$/, '');
        await fetch(`${baseUrl}/clear-rescan`, { method: 'POST' });
      } catch (e) {
        // Ignore
      }
      return;
    }

    // Clear the rescan signal on server
    try {
      const baseUrl = serverUrl.replace(/\/upload$/, '');
      await fetch(`${baseUrl}/clear-rescan`, { method: 'POST' });
      console.log('[App] Cleared rescan signal on server');
    } catch (clearError) {
      console.warn('[App] Failed to clear rescan signal:', clearError);
    }

    // Navigate to Scanner
    console.log('[App] Navigating to Scanner for auto-rescan with URI:', finalImageUri);
    navigationRef.navigate('Scanner', { importUri: finalImageUri });

  } catch (error) {
    console.warn('[App] Startup rescan check failed:', error);
  }
}

function App(): React.JSX.Element {
  // Load sessions on app start
  const loadSessions = useAppStore((state) => state.loadSessions);

  useEffect(() => {
    // Load saved sessions
    loadSessions();

    // Warm up TFLite model for fast first-scan performance
    warmupModel().then((result) => {
      if (result.success) {
        console.log(`[App] Model warmed up in ${result.durationMs.toFixed(0)}ms`);
      } else {
        console.warn('[App] Model warmup failed - first scan may be slow');
      }
    });
  }, [loadSessions]);

  // Called when NavigationContainer is ready - this is the right time to navigate
  const handleNavigationReady = useCallback(() => {
    console.log('[App] Navigation ready, checking for startup rescan...');
    // Small delay to let the initial screen render first
    setTimeout(() => {
      checkStartupRescan();
    }, 500);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <NavigationContainer ref={navigationRef} onReady={handleNavigationReady}>
          <Stack.Navigator
            initialRouteName="Home"
            screenOptions={{
              headerShown: false,
              animation: 'slide_from_right',
              contentStyle: { backgroundColor: '#000' },
            }}
          >
            <Stack.Screen name="Home" component={TabsScreen} />
            <Stack.Screen
              name="Scanner"
              component={ScannerScreen}
              options={({ navigation }) => ({
                headerShown: true,
                headerTransparent: true,
                headerTitle: '',
                headerShadowVisible: false,
                gestureEnabled: true,
                headerLeft: () => (
                  <TouchableOpacity
                    onPress={() => {
                      if (navigation.canGoBack()) {
                        navigation.goBack();
                      } else {
                        navigation.navigate('Home');
                      }
                    }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={{ paddingHorizontal: 12, paddingVertical: 8 }}
                  >
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Close</Text>
                  </TouchableOpacity>
                ),
              })}
            />
            <Stack.Screen name="Results" component={ResultsScreen} />
            <Stack.Screen name="Debug" component={DebugScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default App;
