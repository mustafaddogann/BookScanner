import React from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types';
import { DEBUG_ARTIFACTS_ENABLED } from '../config/debug';
import { useDebugStore } from '../store/useDebugStore';

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
});
