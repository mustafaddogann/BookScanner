/**
 * BookScanner - Main Application Entry Point
 *
 * Bare React Native + TypeScript app for book spine detection
 * using YOLOv8 OBB (Oriented Bounding Boxes)
 */

import React, { useEffect } from 'react';
import {
  StatusBar,
  LogBox,
  NativeModules,
  Platform,
  Text,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ScannerScreen, ResultsScreen, DebugScreen, SettingsScreen, TabsScreen } from './src/screens';
import { useAppStore } from './src/store/useAppStore';
import { warmupModel } from './src/services/inferenceService';
import type { RootStackParamList } from './src/types';

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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <NavigationContainer>
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
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default App;
