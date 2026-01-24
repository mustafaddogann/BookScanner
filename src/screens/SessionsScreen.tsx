import React, { useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Image } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, ScanSession } from '../types';
import { useAppStore } from '../store/useAppStore';
import { ensureFileUri } from '../utils/fileUri';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

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

export function SessionsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const sessions = useAppStore((state) => state.sessions);

  const recentSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return timeB - timeA;
    });
    return sorted;
  }, [sessions]);

  const handleOpenSession = useCallback((sessionId: string) => {
    navigation.navigate('Results', { sessionId });
  }, [navigation]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Sessions</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {recentSessions.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No sessions yet</Text>
            <Text style={styles.emptySubtext}>Your scans will appear here.</Text>
          </View>
        ) : (
          recentSessions.map((session) => (
            <TouchableOpacity
              key={session.sessionId}
              style={styles.sessionCard}
              onPress={() => handleOpenSession(session.sessionId)}
            >
              <View style={styles.thumbnail}>
                {session.imagePath ? (
                  <Image
                    source={{ uri: ensureFileUri(session.imagePath) }}
                    style={styles.thumbnailImage}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={styles.thumbnailPlaceholder}>
                    <Text style={styles.thumbnailPlaceholderText}>—</Text>
                  </View>
                )}
              </View>
              <View style={styles.sessionInfo}>
                <Text style={styles.sessionTitle}>{formatSessionLabel(session)}</Text>
                <Text style={styles.sessionMeta}>
                  {formatSessionDate(session.createdAt)}
                </Text>
                {typeof session.detectionCount === 'number' && (
                  <Text style={styles.sessionMeta}>
                    Books: {session.detectionCount}
                  </Text>
                )}
              </View>
              <View style={styles.statusColumn}>
                <View
                  style={[
                    styles.statusDot,
                    session.status === 'completed' && styles.statusDotSuccess,
                    session.status === 'error' && styles.statusDotError,
                  ]}
                />
                <Text style={styles.sessionStatus}>{session.status}</Text>
              </View>
            </TouchableOpacity>
          ))
        )}
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
    paddingBottom: 12,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '600',
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 24,
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
  thumbnail: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#2c2c2e',
    marginRight: 12,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  thumbnailPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumbnailPlaceholderText: {
    color: '#636366',
    fontSize: 16,
    fontWeight: '600',
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
  statusColumn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#636366',
    marginBottom: 6,
  },
  statusDotSuccess: {
    backgroundColor: '#30D158',
  },
  statusDotError: {
    backgroundColor: '#FF453A',
  },
  sessionStatus: {
    color: '#636366',
    fontSize: 12,
    textTransform: 'capitalize',
  },
});
