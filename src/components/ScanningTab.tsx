import React, { useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, ScrollView, Image, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, ScanSession } from '../types';
import { useAppStore } from '../store/useAppStore';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';
import { ensureFileUri } from '../utils/fileUri';
import { colors, fonts, spacing, radii, shadows } from '../theme';
import { AnimatedPressable } from './AnimatedPressable';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

function formatRelativeDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatSessionLabel(session: ScanSession): string {
  if (session.source === 'fixture') {
    return session.fixtureName ? `Fixture: ${session.fixtureName}` : 'Fixture scan';
  }
  return 'Camera scan';
}

function getStatusInfo(status: string): { label: string; color: string; bg: string } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: colors.verified, bg: 'rgba(126, 200, 126, 0.1)' };
    case 'error':
      return { label: 'Error', color: colors.rejected, bg: 'rgba(199, 92, 92, 0.1)' };
    case 'processing':
      return { label: 'Processing', color: colors.primary, bg: colors.primaryMuted };
    default:
      return { label: status, color: colors.textTertiary, bg: colors.bgNested };
  }
}

export function ScanningTab(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const sessions = useAppStore((s) => s.sessions);
  const scans = useBackgroundScanStore((s) => s.scans);

  const activeScans = useMemo(() => Object.values(scans), [scans]);

  const completedSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return timeB - timeA;
    });
    return sorted.slice(0, 20);
  }, [sessions]);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      navigation.navigate('Results', { sessionId });
    },
    [navigation],
  );

  const hasActive = activeScans.length > 0;
  const hasCompleted = completedSessions.length > 0;

  if (!hasActive && !hasCompleted) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyState}>
          <View style={styles.emptyIconBg}>
            <Text style={styles.emptyIcon}>{'\u{1F4F7}'}</Text>
          </View>
          <Text style={styles.emptyTitle}>No scans yet</Text>
          <Text style={styles.emptySubtext}>
            Scan a bookshelf to see your scanning activity here.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Active Scans */}
      {hasActive && (
        <>
          <Text style={styles.sectionLabel}>ACTIVE</Text>
          {activeScans.map((scan) => (
            <View key={scan.sessionId} style={styles.activeCard}>
              <View style={styles.activeLeftBorder} />
              <View style={styles.activeContent}>
                <View style={styles.activeRow}>
                  <Text style={styles.activeStage} numberOfLines={1}>
                    {scan.stage ?? 'Processing...'}
                  </Text>
                  <ActivityIndicator size="small" color={colors.primary} />
                </View>
                {scan.error && (
                  <Text style={styles.activeError} numberOfLines={1}>
                    {scan.error}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </>
      )}

      {/* Completed Sessions */}
      {hasCompleted && (
        <>
          <Text style={[styles.sectionLabel, hasActive && styles.sectionLabelSpaced]}>
            COMPLETED
          </Text>
          {completedSessions.map((session) => {
            const statusInfo = getStatusInfo(session.status);
            return (
              <AnimatedPressable
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
                      <Text style={styles.thumbnailPlaceholderText}>{'\u{1F4F7}'}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionTitle} numberOfLines={1}>
                    {formatSessionLabel(session)}
                  </Text>
                  <View style={styles.sessionMetaRow}>
                    <Text style={styles.sessionDate}>
                      {formatRelativeDate(session.createdAt)}
                    </Text>
                    {typeof session.detectionCount === 'number' && (
                      <>
                        <View style={styles.metaDot} />
                        <Text style={styles.sessionBooks}>
                          {session.detectionCount} book{session.detectionCount === 1 ? '' : 's'}
                        </Text>
                      </>
                    )}
                  </View>
                </View>
                <View style={[styles.statusPill, { backgroundColor: statusInfo.bg }]}>
                  <View style={[styles.statusDot, { backgroundColor: statusInfo.color }]} />
                  <Text style={[styles.statusLabel, { color: statusInfo.color }]}>
                    {statusInfo.label}
                  </Text>
                </View>
              </AnimatedPressable>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  sectionLabelSpaced: {
    marginTop: spacing.xxl,
  },

  // Active scan cards
  activeCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    flexDirection: 'row',
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  activeLeftBorder: {
    width: 3,
    backgroundColor: colors.primary,
  },
  activeContent: {
    flex: 1,
    padding: spacing.lg,
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  activeStage: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
    marginRight: spacing.md,
  },
  activeError: {
    color: colors.rejected,
    fontSize: 12,
    marginTop: spacing.xs,
  },

  // Session cards (completed)
  sessionCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.bgNested,
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
    fontSize: 18,
  },
  sessionInfo: {
    flex: 1,
    marginLeft: spacing.lg,
    marginRight: spacing.sm,
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  sessionDate: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  metaDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.textMuted,
    marginHorizontal: 6,
  },
  sessionBooks: {
    color: colors.textTertiary,
    fontSize: 12,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radii.pill,
    gap: 5,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '600',
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
  },
  emptyState: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xxl,
    padding: spacing.xxxl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  emptyIconBg: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  emptyIcon: {
    fontSize: 24,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.xs,
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
});
