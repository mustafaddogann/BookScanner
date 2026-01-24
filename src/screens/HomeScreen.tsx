import React, { useCallback, useMemo, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, ScanSession } from '../types';
import { useAppStore } from '../store/useAppStore';
import { launchImageLibrary } from 'react-native-image-picker';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

interface HomeScreenProps {
  onOpenSettings?: () => void;
}

function formatSessionLabel(session: ScanSession): string {
  if (session.source === 'fixture') {
    return session.fixtureName ? `Fixture: ${session.fixtureName}` : 'Fixture scan';
  }
  return 'Camera scan';
}

function formatSessionDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleString();
}

export function HomeScreen({ onOpenSettings }: HomeScreenProps): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const sessions = useAppStore((state) => state.sessions);
  const [importError, setImportError] = useState<string | null>(null);

  const recentSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return timeB - timeA;
    });
    return sorted.slice(0, 3);
  }, [sessions]);

  const handleScan = useCallback(() => {
    navigation.navigate('Scanner');
  }, [navigation]);

  const handleSettings = useCallback(() => {
    if (onOpenSettings) {
      onOpenSettings();
      return;
    }
    navigation.navigate('Settings');
  }, [navigation, onOpenSettings]);

  const handleImport = useCallback(async () => {
    setImportError(null);
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
      });

      if (result.didCancel) {
        return;
      }

      if (result.errorCode) {
        setImportError(result.errorMessage || 'Unable to open photo library.');
        return;
      }

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setImportError('No photo selected.');
        return;
      }

      navigation.navigate('Scanner', { importUri: asset.uri });
    } catch (error: any) {
      setImportError(error?.message || 'Failed to import photo.');
    }
  }, [navigation]);

  const handleOpenSession = useCallback((sessionId: string) => {
    navigation.navigate('Results', { sessionId });
  }, [navigation]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>ShelfScan</Text>
          <Text style={styles.subtitle}>Detect spines → OCR → clean metadata</Text>
        </View>
        <TouchableOpacity onPress={handleSettings} style={styles.settingsButton}>
          <Text style={styles.settingsText}>Settings</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.primaryButton} onPress={handleScan}>
          <Text style={styles.primaryButtonText}>Scan shelf</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={handleImport}>
          <Text style={styles.secondaryButtonText}>Import photo</Text>
        </TouchableOpacity>
        {importError && (
          <Text style={styles.importErrorText}>{importError}</Text>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent sessions</Text>
          {recentSessions.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No sessions yet</Text>
              <Text style={styles.emptySubtext}>Your last 3 scans will show up here.</Text>
            </View>
          ) : (
            recentSessions.map((session) => (
              <TouchableOpacity
                key={session.sessionId}
                style={styles.sessionCard}
                onPress={() => handleOpenSession(session.sessionId)}
              >
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionTitle}>{formatSessionLabel(session)}</Text>
                  <Text style={styles.sessionMeta}>
                    {formatSessionDate(session.createdAt)} • {session.detectionCount} detections
                  </Text>
                </View>
                <Text style={styles.sessionStatus}>{session.status}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#8e8e93',
    fontSize: 14,
    marginTop: 6,
  },
  settingsButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  settingsText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#8e8e93',
    fontSize: 16,
    fontWeight: '600',
  },
  importErrorText: {
    color: '#FF453A',
    fontSize: 12,
    marginTop: 6,
    marginBottom: 16,
    textAlign: 'center',
  },
  section: {
    marginTop: 8,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  emptyState: {
    backgroundColor: '#1c1c1e',
    padding: 16,
    borderRadius: 10,
  },
  emptyText: {
    color: '#8e8e93',
    fontSize: 14,
  },
  emptySubtext: {
    color: '#636366',
    fontSize: 12,
    marginTop: 6,
  },
  sessionCard: {
    backgroundColor: '#1c1c1e',
    padding: 14,
    borderRadius: 10,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sessionInfo: {
    flex: 1,
    marginRight: 12,
  },
  sessionTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  sessionMeta: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 4,
  },
  sessionStatus: {
    color: '#636366',
    fontSize: 12,
    textTransform: 'capitalize',
  },
});
