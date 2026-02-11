import React, { useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, Alert, ActionSheetIOS, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { DEBUG_ARTIFACTS_ENABLED } from '../config/debug';
import { useDebugStore } from '../store/useDebugStore';
import { getServerUrl, setServerUrl, checkRescanStatus } from '../services/autoExportService';
import RNFS from 'react-native-fs';

// Test fixture paths (bundled with app in debug builds)
const TEST_FIXTURES = [
  { name: 'Shelf 001 - Mystery (vertical)', filename: 'shelf_001.jpg' },
  { name: 'Shelf 002 - Mystery & Crime (horizontal)', filename: 'shelf_002.jpg' },
];

const AUTO_RETRY_KEY = 'auto_retry_enabled';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

// Diagnostics toggle is only functional in debug builds
const DIAGNOSTICS_ALLOWED = __DEV__;

interface SettingsScreenProps {
  onBack?: () => void;
}

export function SettingsScreen({ onBack }: SettingsScreenProps): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();

  // Use persistent store for diagnostics setting
  const diagnosticsEnabled = useDebugStore((state) => state.diagnosticsEnabled);
  const setDiagnosticsEnabled = useDebugStore((state) => state.setDiagnosticsEnabled);
  const autoRetryEnabled = useDebugStore((state) => state.autoRetryEnabled);
  const setAutoRetryEnabled = useDebugStore((state) => state.setAutoRetryEnabled);

  // ClawdBot server URL for auto-export
  const [serverUrl, setLocalServerUrl] = useState<string>(() => getServerUrl() || '');
  const [serverUrlEditing, setServerUrlEditing] = useState(false);

  const handleSaveServerUrl = () => {
    const trimmed = serverUrl.trim();
    if (trimmed && !trimmed.startsWith('http')) {
      Alert.alert('Invalid URL', 'URL must start with http:// or https://');
      return;
    }
    setServerUrl(trimmed || null);
    setServerUrlEditing(false);
    Alert.alert('Saved', trimmed ? 'Server URL saved' : 'Server URL cleared');
  };

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    navigation.goBack();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Diagnostics</Text>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Enable diagnostics</Text>
            <TouchableOpacity
              style={[
                styles.toggle,
                diagnosticsEnabled && styles.toggleActive,
                !DIAGNOSTICS_ALLOWED && styles.toggleDisabled,
              ]}
              onPress={() => {
                if (DIAGNOSTICS_ALLOWED) {
                  setDiagnosticsEnabled(!diagnosticsEnabled);
                }
              }}
              disabled={!DIAGNOSTICS_ALLOWED}
            >
              <Text
                style={[
                  styles.toggleText,
                  diagnosticsEnabled && styles.toggleTextActive,
                  !DIAGNOSTICS_ALLOWED && styles.toggleTextDisabled,
                ]}
              >
                {diagnosticsEnabled ? 'On' : 'Off'}
              </Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.settingNote}>
            {DIAGNOSTICS_ALLOWED
              ? (DEBUG_ARTIFACTS_ENABLED
                  ? 'Debug artifacts are available in this build.'
                  : 'Diagnostics enabled. Debug artifacts will be generated.')
              : 'Diagnostics require a debug-enabled build. Toggle is disabled.'}
          </Text>

        </View>

        {/* Developer section - only visible in debug builds */}
        {__DEV__ && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Developer</Text>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Open Diagnostics</Text>
              <TouchableOpacity
                style={styles.devButton}
                onPress={() => navigation.navigate('Diagnostics', undefined)}
              >
                <Text style={styles.devButtonText}>Open</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Open Debug</Text>
              <TouchableOpacity
                style={styles.devButton}
                onPress={() => navigation.navigate('Debug')}
              >
                <Text style={styles.devButtonText}>Open</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Auto-Retry Mode</Text>
              <TouchableOpacity
                style={[
                  styles.toggle,
                  autoRetryEnabled && styles.toggleActive,
                ]}
                onPress={() => setAutoRetryEnabled(!autoRetryEnabled)}
              >
                <Text
                  style={[
                    styles.toggleText,
                    autoRetryEnabled && styles.toggleTextActive,
                  ]}
                >
                  {autoRetryEnabled ? 'On' : 'Off'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.settingNote}>
              {autoRetryEnabled
                ? 'Auto-retry enabled: Will retry resolution every 10s'
                : 'Enable for automated testing (retries until 0 rejects)'}
            </Text>

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>ClawdBot Server</Text>
              <TouchableOpacity
                style={styles.devButton}
                onPress={() => setServerUrlEditing(true)}
              >
                <Text style={styles.devButtonText}>
                  {serverUrl ? 'Edit' : 'Setup'}
                </Text>
              </TouchableOpacity>
            </View>
            {serverUrl ? (
              <Text style={styles.settingNote}>
                Auto-upload enabled: {serverUrl.substring(0, 30)}...
              </Text>
            ) : (
              <Text style={styles.settingNote}>
                Run `node scripts/rejectsServer.js` on Mac to get URL
              </Text>
            )}

            {serverUrl && (
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Check for Rescan</Text>
                <TouchableOpacity
                  style={styles.devButton}
                  onPress={async () => {
                    try {
                      const status = await checkRescanStatus();
                      if (status.rescan) {
                        Alert.alert(
                          'Rescan Signal',
                          `Reason: ${status.reason}\n\nLast analysis: ${status.latestAnalysis?.rejectCount || 0} rejects`,
                          [
                            { text: 'Later', style: 'cancel' },
                            {
                              text: 'Rescan Now',
                              onPress: () => {
                                // TODO: Trigger rescan - for now just navigate to scanner
                                Alert.alert('Rescan', 'Navigate to scanner and scan again');
                              }
                            }
                          ]
                        );
                      } else {
                        Alert.alert('No Rescan Needed', 'No pending rescan signal from server.');
                      }
                    } catch (err: any) {
                      Alert.alert('Error', err.message);
                    }
                  }}
                >
                  <Text style={styles.devButtonText}>Check</Text>
                </TouchableOpacity>
              </View>
            )}

            {serverUrlEditing && (
              <View style={styles.serverUrlInput}>
                <TextInput
                  style={styles.textInput}
                  value={serverUrl}
                  onChangeText={setLocalServerUrl}
                  placeholder="http://192.168.x.x:8765/upload"
                  placeholderTextColor="#666"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <View style={styles.serverUrlButtons}>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => setServerUrlEditing(false)}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.saveButton}
                    onPress={handleSaveServerUrl}
                  >
                    <Text style={styles.saveButtonText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Load Test Fixture</Text>
              <TouchableOpacity
                style={styles.devButton}
                onPress={() => {
                  if (Platform.OS === 'ios') {
                    ActionSheetIOS.showActionSheetWithOptions(
                      {
                        options: ['Cancel', ...TEST_FIXTURES.map(f => f.name)],
                        cancelButtonIndex: 0,
                        title: 'Select Test Shelf Image',
                      },
                      async (buttonIndex) => {
                        if (buttonIndex === 0) return; // Cancel
                        const fixture = TEST_FIXTURES[buttonIndex - 1];

                        // Try multiple locations for test fixtures
                        const possiblePaths = [
                          // Direct in bundle root (Xcode copies resources flat)
                          `${RNFS.MainBundlePath}/${fixture.filename}`,
                          // TestFixtures folder in bundle (if Xcode preserves structure)
                          `${RNFS.MainBundlePath}/TestFixtures/${fixture.filename}`,
                          // App Documents/TestFixtures (copied by script)
                          `${RNFS.DocumentDirectoryPath}/TestFixtures/${fixture.filename}`,
                        ];

                        for (const testPath of possiblePaths) {
                          const exists = await RNFS.exists(testPath);
                          if (exists) {
                            console.log(`[TestFixture] Found at: ${testPath}`);
                            navigation.navigate('Scanner', { importUri: `file://${testPath}` });
                            return;
                          }
                        }

                        // Not found - show instructions
                        Alert.alert(
                          'Test Fixture Not Found',
                          `To use test fixtures:\n\n` +
                          `1. On Mac: Run 'node scripts/copyTestFixtures.js'\n` +
                          `2. Or: Import "${fixture.filename}" from Photos\n\n` +
                          `Files are in: test_fixtures/shelves/`,
                          [{ text: 'OK' }]
                        );
                      }
                    );
                  } else {
                    Alert.alert('Not Supported', 'Test fixtures are only available on iOS');
                  }
                }}
              >
                <Text style={styles.devButtonText}>Load</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.settingNote}>
              Load saved shelf images for testing without camera import
            </Text>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Version</Text>
            <Text style={styles.settingValue}>v0.0.0</Text>
          </View>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>Build</Text>
            <Text style={styles.settingValue}>dev</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Help</Text>
          <Text style={styles.helpText}>
            Scan a shelf, tap a book to review details, and edit title/author when needed.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
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
  headerSpacer: {
    width: 48,
  },
  content: {
    flex: 1,
    padding: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  settingLabel: {
    color: '#fff',
    fontSize: 14,
  },
  settingValue: {
    color: '#8e8e93',
    fontSize: 13,
  },
  settingNote: {
    color: '#636366',
    fontSize: 12,
    marginTop: 6,
  },
  toggle: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  toggleActive: {
    backgroundColor: '#007AFF',
  },
  toggleDisabled: {
    backgroundColor: '#1c1c1e',
    opacity: 0.5,
  },
  toggleText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  toggleTextActive: {
    color: '#fff',
  },
  toggleTextDisabled: {
    color: '#636366',
  },
  helpText: {
    color: '#8e8e93',
    fontSize: 13,
    lineHeight: 18,
  },
  devButton: {
    backgroundColor: '#FF9F0A',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  devButtonText: {
    color: '#000',
    fontSize: 12,
    fontWeight: '600',
  },
  serverUrlInput: {
    marginTop: 12,
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
    padding: 12,
  },
  textInput: {
    backgroundColor: '#2c2c2e',
    color: '#fff',
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
  },
  serverUrlButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
    gap: 10,
  },
  cancelButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#3a3a3c',
  },
  cancelButtonText: {
    color: '#fff',
    fontSize: 14,
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#007AFF',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
