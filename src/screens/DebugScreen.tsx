/**
 * DebugScreen - Lists fixtures and runs full pipeline on selection
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, FixtureInfo } from '../types';
import { loadAllFixtures, getDevFixtureInstructions } from '../services/fixtureService';
import { runPipelineOnFixture } from '../services/pipelineService';
import { listSessions, getSessionDir, readDebugManifest } from '../services/debugArtifacts';
import { useAppStore } from '../store/useAppStore';

type NavigationProp = NativeStackNavigationProp<RootStackParamList, 'Debug'>;

interface SessionInfo {
  sessionId: string;
  createdAt: string;
  source: 'camera' | 'fixture';
  fixtureName?: string;
  detectionCount: number;
}

export function DebugScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();

  const [bundledFixtures, setBundledFixtures] = useState<FixtureInfo[]>([]);
  const [deviceFixtures, setDeviceFixtures] = useState<FixtureInfo[]>([]);
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runningFixture, setRunningFixture] = useState<string | null>(null);

  const { isProcessing, processingStage } = useAppStore();

  // Load fixtures and sessions
  const loadData = useCallback(async () => {
    try {
      // Load fixtures
      const { bundled, device } = await loadAllFixtures();
      setBundledFixtures(bundled);
      setDeviceFixtures(device);

      // Load recent sessions
      const sessionIds = await listSessions();
      const sessions: SessionInfo[] = [];

      for (const sessionId of sessionIds.slice(0, 10)) {
        const manifest = await readDebugManifest(sessionId);
        if (manifest) {
          sessions.push({
            sessionId,
            createdAt: manifest.createdAt,
            source: manifest.source,
            fixtureName: manifest.fixtureName,
            detectionCount: manifest.detectionsOriginal.length,
          });
        }
      }

      setRecentSessions(sessions);
    } catch (error) {
      console.error('[Debug] Failed to load data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle refresh
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  // Handle fixture selection
  const handleFixturePress = useCallback(async (fixture: FixtureInfo) => {
    if (isProcessing || runningFixture) return;

    setRunningFixture(fixture.id);

    try {
      console.log(`[Debug] Running pipeline on fixture: ${fixture.name}`);

      const result = await runPipelineOnFixture(fixture.uri, fixture.name);

      console.log(`[Debug] Pipeline complete. ${result.detections.length} detections`);

      // Navigate to results
      navigation.navigate('Results', { sessionId: result.session.sessionId });
    } catch (error: any) {
      console.error('[Debug] Pipeline error:', error);
      Alert.alert('Pipeline Error', error.message);
    } finally {
      setRunningFixture(null);
    }
  }, [isProcessing, runningFixture, navigation]);

  // Handle session press
  const handleSessionPress = useCallback((sessionId: string) => {
    navigation.navigate('Results', { sessionId });
  }, [navigation]);

  // Show instructions
  const showInstructions = useCallback(() => {
    Alert.alert('Dev Fixtures', getDevFixtureInstructions());
  }, []);

  // Handle back navigation
  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading fixtures...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Debug</Text>
        <TouchableOpacity onPress={showInstructions} style={styles.infoButton}>
          <Text style={styles.infoButtonText}>Info</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor="#fff"
          />
        }
      >
        {/* Processing indicator */}
        {(isProcessing || runningFixture) && (
          <View style={styles.processingBanner}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={styles.processingText}>
              {processingStage || 'Processing...'}
            </Text>
          </View>
        )}

        {/* Bundled Fixtures */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Bundled Fixtures</Text>
          <Text style={styles.sectionSubtitle}>
            Golden fixtures shipped with app
          </Text>

          {bundledFixtures.length === 0 ? (
            <Text style={styles.emptyText}>No bundled fixtures available</Text>
          ) : (
            bundledFixtures.map((fixture) => (
              <TouchableOpacity
                key={fixture.id}
                style={[
                  styles.fixtureItem,
                  runningFixture === fixture.id && styles.fixtureItemRunning,
                ]}
                onPress={() => handleFixturePress(fixture)}
                disabled={isProcessing || !!runningFixture}
              >
                <View style={styles.fixtureInfo}>
                  <Text style={styles.fixtureName}>{fixture.name}</Text>
                  {fixture.description && (
                    <Text style={styles.fixtureDescription}>
                      {fixture.description}
                    </Text>
                  )}
                </View>
                <View style={styles.fixtureRight}>
                  {fixture.expectedDetections !== undefined && (
                    <Text style={styles.fixtureExpected}>
                      ~{fixture.expectedDetections}
                    </Text>
                  )}
                  {runningFixture === fixture.id && (
                    <ActivityIndicator size="small" color="#007AFF" />
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Device Fixtures */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Device Fixtures</Text>
          <Text style={styles.sectionSubtitle}>
            Loaded from Documents/BookScanner/fixtures/
          </Text>

          {deviceFixtures.length === 0 ? (
            <TouchableOpacity onPress={showInstructions}>
              <Text style={styles.emptyText}>
                No device fixtures found. Tap for instructions.
              </Text>
            </TouchableOpacity>
          ) : (
            deviceFixtures.map((fixture) => (
              <TouchableOpacity
                key={fixture.id}
                style={[
                  styles.fixtureItem,
                  runningFixture === fixture.id && styles.fixtureItemRunning,
                ]}
                onPress={() => handleFixturePress(fixture)}
                disabled={isProcessing || !!runningFixture}
              >
                <View style={styles.fixtureInfo}>
                  <Text style={styles.fixtureName}>{fixture.name}</Text>
                  {fixture.description && (
                    <Text style={styles.fixtureDescription}>
                      {fixture.description}
                    </Text>
                  )}
                  {fixture.groundTruthLabels && (
                    <Text style={styles.fixtureLabels}>Has ground truth labels</Text>
                  )}
                </View>
                <View style={styles.fixtureRight}>
                  {runningFixture === fixture.id && (
                    <ActivityIndicator size="small" color="#007AFF" />
                  )}
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Recent Sessions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Sessions</Text>
          <Text style={styles.sectionSubtitle}>
            View previous pipeline runs
          </Text>

          {recentSessions.length === 0 ? (
            <Text style={styles.emptyText}>No recent sessions</Text>
          ) : (
            recentSessions.map((session) => (
              <TouchableOpacity
                key={session.sessionId}
                style={styles.sessionItem}
                onPress={() => handleSessionPress(session.sessionId)}
              >
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionName}>
                    {session.source === 'fixture'
                      ? session.fixtureName || 'Fixture'
                      : 'Camera Capture'}
                  </Text>
                  <Text style={styles.sessionDate}>
                    {new Date(session.createdAt).toLocaleString()}
                  </Text>
                </View>
                <View style={styles.sessionRight}>
                  <Text style={styles.sessionCount}>
                    {session.detectionCount} detections
                  </Text>
                  <Text style={styles.sessionSource}>
                    {session.source}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* Bottom padding */}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  loadingText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 16,
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
  infoButton: {
    padding: 8,
  },
  infoButtonText: {
    color: '#007AFF',
    fontSize: 16,
  },
  scrollView: {
    flex: 1,
  },
  processingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    padding: 12,
  },
  processingText: {
    color: '#fff',
    fontSize: 14,
    marginLeft: 8,
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 4,
  },
  sectionSubtitle: {
    color: '#8e8e93',
    fontSize: 14,
    marginBottom: 16,
  },
  emptyText: {
    color: '#8e8e93',
    fontSize: 14,
    fontStyle: 'italic',
    textAlign: 'center',
    padding: 16,
  },
  fixtureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1c1c1e',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  fixtureItemRunning: {
    backgroundColor: '#2c2c2e',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  fixtureInfo: {
    flex: 1,
  },
  fixtureName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  fixtureDescription: {
    color: '#8e8e93',
    fontSize: 13,
  },
  fixtureLabels: {
    color: '#32D74B',
    fontSize: 12,
    marginTop: 4,
  },
  fixtureRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fixtureExpected: {
    color: '#8e8e93',
    fontSize: 14,
    marginRight: 8,
  },
  sessionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1c1c1e',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  sessionInfo: {
    flex: 1,
  },
  sessionName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  sessionDate: {
    color: '#8e8e93',
    fontSize: 13,
  },
  sessionRight: {
    alignItems: 'flex-end',
  },
  sessionCount: {
    color: '#fff',
    fontSize: 14,
    marginBottom: 2,
  },
  sessionSource: {
    color: '#8e8e93',
    fontSize: 12,
  },
});
