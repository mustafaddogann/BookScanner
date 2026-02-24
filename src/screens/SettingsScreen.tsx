/**
 * SettingsScreen - Clean, sectioned settings with proper hierarchy
 *
 * UX: Settings are grouped by audience.
 * Regular users see: Diagnostics toggle, About, Help.
 * Developers see: Additional debug tools and server config.
 * Each section has a clear title and divider.
 */

import React, { useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, TextInput, Alert, ActionSheetIOS, Platform, ScrollView } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { DEBUG_ARTIFACTS_ENABLED } from '../config/debug';
import { useDebugStore } from '../store/useDebugStore';
import { getServerUrl, setServerUrl, checkRescanStatus } from '../services/autoExportService';
import RNFS from 'react-native-fs';
import { colors, fonts, spacing, radii } from '../theme';

const TEST_FIXTURES = [
  { name: 'Shelf 001 - Mystery (vertical)', filename: 'shelf_001.jpg' },
  { name: 'Shelf 002 - Mystery & Crime (horizontal)', filename: 'shelf_002.jpg' },
];

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

const DIAGNOSTICS_ALLOWED = __DEV__;

interface SettingsScreenProps {
  onBack?: () => void;
}

function SettingRow({ label, right }: { label: string; right: React.ReactNode }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      {right}
    </View>
  );
}

function ToggleChip({
  value,
  onToggle,
  disabled,
}: {
  value: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.toggle,
        value && styles.toggleActive,
        disabled && styles.toggleDisabled,
      ]}
      onPress={onToggle}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <Text style={[
        styles.toggleText,
        value && styles.toggleTextActive,
        disabled && styles.toggleTextDisabled,
      ]}>
        {value ? 'On' : 'Off'}
      </Text>
    </TouchableOpacity>
  );
}

function SmallButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.smallButton} onPress={onPress} activeOpacity={0.7}>
      <Text style={styles.smallButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function SettingsScreen({ onBack }: SettingsScreenProps): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();

  const diagnosticsEnabled = useDebugStore((state) => state.diagnosticsEnabled);
  const setDiagnosticsEnabled = useDebugStore((state) => state.setDiagnosticsEnabled);
  const autoRetryEnabled = useDebugStore((state) => state.autoRetryEnabled);
  const setAutoRetryEnabled = useDebugStore((state) => state.setAutoRetryEnabled);

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
          <Text style={styles.backButtonText}>{'\u2039'} Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Diagnostics */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Diagnostics</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              label="Enable diagnostics"
              right={
                <ToggleChip
                  value={diagnosticsEnabled}
                  onToggle={() => DIAGNOSTICS_ALLOWED && setDiagnosticsEnabled(!diagnosticsEnabled)}
                  disabled={!DIAGNOSTICS_ALLOWED}
                />
              }
            />
            <Text style={styles.hint}>
              {DIAGNOSTICS_ALLOWED
                ? (DEBUG_ARTIFACTS_ENABLED
                    ? 'Debug artifacts are available in this build.'
                    : 'Diagnostics enabled. Debug artifacts will be generated.')
                : 'Diagnostics require a debug-enabled build.'}
            </Text>
          </View>
        </View>

        {/* Developer Tools — only in __DEV__ */}
        {__DEV__ && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Developer</Text>
            <View style={styles.sectionCard}>
              <SettingRow
                label="Open Diagnostics"
                right={<SmallButton label="Open" onPress={() => navigation.navigate('Diagnostics', undefined)} />}
              />
              <View style={styles.divider} />
              <SettingRow
                label="Open Debug"
                right={<SmallButton label="Open" onPress={() => navigation.navigate('Debug')} />}
              />
              <View style={styles.divider} />
              <SettingRow
                label="Auto-Retry Mode"
                right={
                  <ToggleChip
                    value={autoRetryEnabled}
                    onToggle={() => setAutoRetryEnabled(!autoRetryEnabled)}
                  />
                }
              />
              <Text style={styles.hint}>
                {autoRetryEnabled
                  ? 'Auto-retry active: retries resolution every 10s'
                  : 'Enable for automated testing (retries until 0 rejects)'}
              </Text>

              <View style={styles.divider} />
              <SettingRow
                label="ClawdBot Server"
                right={
                  <SmallButton
                    label={serverUrl ? 'Edit' : 'Setup'}
                    onPress={() => setServerUrlEditing(true)}
                  />
                }
              />
              <Text style={styles.hint}>
                {serverUrl
                  ? `Connected: ${serverUrl.substring(0, 30)}...`
                  : 'Run `node scripts/rejectsServer.js` on Mac'}
              </Text>

              {serverUrl && (
                <>
                  <View style={styles.divider} />
                  <SettingRow
                    label="Check for Rescan"
                    right={
                      <SmallButton
                        label="Check"
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
                      />
                    }
                  />
                </>
              )}

              {serverUrlEditing && (
                <View style={styles.serverUrlInput}>
                  <TextInput
                    style={styles.textInput}
                    value={serverUrl}
                    onChangeText={setLocalServerUrl}
                    placeholder="http://192.168.x.x:8765/upload"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                  <View style={styles.serverUrlActions}>
                    <TouchableOpacity style={styles.urlCancelBtn} onPress={() => setServerUrlEditing(false)}>
                      <Text style={styles.urlCancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.urlSaveBtn} onPress={handleSaveServerUrl}>
                      <Text style={styles.urlSaveText}>Save</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              <View style={styles.divider} />
              <SettingRow
                label="Load Test Fixture"
                right={
                  <SmallButton
                    label="Load"
                    onPress={() => {
                      if (Platform.OS === 'ios') {
                        ActionSheetIOS.showActionSheetWithOptions(
                          {
                            options: ['Cancel', ...TEST_FIXTURES.map(f => f.name)],
                            cancelButtonIndex: 0,
                            title: 'Select Test Shelf Image',
                          },
                          async (buttonIndex) => {
                            if (buttonIndex === 0) return;
                            const fixture = TEST_FIXTURES[buttonIndex - 1];
                            const possiblePaths = [
                              `${RNFS.MainBundlePath}/${fixture.filename}`,
                              `${RNFS.MainBundlePath}/TestFixtures/${fixture.filename}`,
                              `${RNFS.DocumentDirectoryPath}/TestFixtures/${fixture.filename}`,
                            ];
                            for (const testPath of possiblePaths) {
                              const exists = await RNFS.exists(testPath);
                              if (exists) {
                                navigation.navigate('Scanner', { importUri: `file://${testPath}` });
                                return;
                              }
                            }
                            Alert.alert(
                              'Test Fixture Not Found',
                              `To use test fixtures:\n\n1. On Mac: Run 'node scripts/copyTestFixtures.js'\n2. Or: Import "${fixture.filename}" from Photos\n\nFiles are in: test_fixtures/shelves/`,
                              [{ text: 'OK' }]
                            );
                          }
                        );
                      } else {
                        Alert.alert('Not Supported', 'Test fixtures are only available on iOS');
                      }
                    }}
                  />
                }
              />
              <Text style={styles.hint}>
                Load saved shelf images for testing without camera
              </Text>
            </View>
          </View>
        )}

        {/* About */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              label="Version"
              right={<Text style={styles.settingValue}>v0.0.0</Text>}
            />
            <View style={styles.divider} />
            <SettingRow
              label="Build"
              right={<Text style={styles.settingValue}>dev</Text>}
            />
          </View>
        </View>

        {/* Help */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Help</Text>
          <View style={styles.sectionCard}>
            <Text style={styles.helpText}>
              Scan a shelf, tap a book to review details, and edit title/author when needed.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xxl,
    paddingTop: 60,
    paddingBottom: spacing.lg,
  },
  backButton: {
    padding: spacing.sm,
  },
  backButtonText: {
    color: colors.primary,
    fontSize: 16,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
  },
  headerSpacer: {
    width: 48,
  },
  content: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },

  // Section
  section: {
    marginBottom: spacing.xxl,
  },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: spacing.md,
    marginLeft: spacing.xs,
  },
  sectionCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },

  // Setting row
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  settingLabel: {
    color: colors.textPrimary,
    fontSize: 14,
    flex: 1,
  },
  settingValue: {
    color: colors.textSecondary,
    fontSize: 13,
  },

  // Divider
  divider: {
    height: 1,
    backgroundColor: colors.separator,
    marginVertical: spacing.md,
  },

  // Hint text
  hint: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
    lineHeight: 16,
  },

  // Toggle
  toggle: {
    backgroundColor: colors.bgNested,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  toggleActive: {
    backgroundColor: colors.primary,
  },
  toggleDisabled: {
    opacity: 0.4,
  },
  toggleText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  toggleTextActive: {
    color: colors.bgDeep,
  },
  toggleTextDisabled: {
    color: colors.textTertiary,
  },

  // Small button
  smallButton: {
    backgroundColor: colors.primaryMuted,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  smallButtonText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },

  // Help
  helpText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 20,
  },

  // Server URL input
  serverUrlInput: {
    marginTop: spacing.md,
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  textInput: {
    backgroundColor: colors.bgDeep,
    color: colors.textPrimary,
    borderRadius: radii.sm,
    padding: spacing.md,
    fontSize: 13,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  serverUrlActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  urlCancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.bgOverlay,
  },
  urlCancelText: {
    color: colors.textPrimary,
    fontSize: 13,
  },
  urlSaveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
  },
  urlSaveText: {
    color: colors.bgDeep,
    fontSize: 13,
    fontWeight: '600',
  },
});
