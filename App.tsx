/**
 * BookScanner - Main Application Entry Point
 *
 * Bare React Native + TypeScript app for book spine detection
 * using YOLOv8 OBB (Oriented Bounding Boxes)
 */

import React, { useEffect } from 'react';
import { StatusBar, LogBox, NativeModules, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ScannerScreen, ResultsScreen, DebugScreen } from './src/screens';
import { useAppStore } from './src/store/useAppStore';
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
    loadSessions();
  }, [loadSessions]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName="Scanner"
            screenOptions={{
              headerShown: false,
              animation: 'slide_from_right',
              contentStyle: { backgroundColor: '#000' },
            }}
          >
            <Stack.Screen name="Scanner" component={ScannerScreen} />
            <Stack.Screen name="Results" component={ResultsScreen} />
            <Stack.Screen name="Debug" component={DebugScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default App;
