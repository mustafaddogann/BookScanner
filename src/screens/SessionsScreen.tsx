import React, { useMemo, useCallback } from 'react';
import { StyleSheet, View, Text, ScrollView, Image, Animated } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, ScanSession } from '../types';
import { useAppStore } from '../store/useAppStore';
import { ensureFileUri } from '../utils/fileUri';
import { colors, fonts, spacing, radii, shadows } from '../theme';
import { useFadeIn } from '../hooks/useFadeIn';
import { AnimatedPressable } from '../components/AnimatedPressable';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

function formatSessionLabel(session: ScanSession): string {
  if (session.source === 'fixture') {
    return session.fixtureName ? `Fixture: ${session.fixtureName}` : 'Fixture scan';
  }
  return 'Camera scan';
}

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

export function SessionsScreen(): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const sessions = useAppStore((state) => state.sessions);
  const headerAnim = useFadeIn(0, 16);

  const recentSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return timeB - timeA;
    });
    return sorted;
  }, [sessions]);

  const totalBooks = useMemo(() => {
    return sessions.reduce((sum, s) => sum + (s.detectionCount || 0), 0);
  }, [sessions]);

  const handleOpenSession = useCallback((sessionId: string) => {
    navigation.navigate('Results', { sessionId });
  }, [navigation]);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.header, headerAnim]}>
        <Text style={styles.title}>My Library</Text>
        <View style={styles.headerStats}>
          <Text style={styles.headerStat}>
            <Text style={styles.headerStatValue}>{sessions.length}</Text> scans
          </Text>
          <View style={styles.headerStatDivider} />
          <Text style={styles.headerStat}>
            <Text style={styles.headerStatValue}>{totalBooks}</Text> books
          </Text>
        </View>
      </Animated.View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {recentSessions.length === 0 ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconBg}>
              <Text style={styles.emptyIcon}>{'\u{1F4DA}'}</Text>
            </View>
            <Text style={styles.emptyTitle}>No sessions yet</Text>
            <Text style={styles.emptySubtext}>
              Your scanned shelves will appear here.
            </Text>
          </View>
        ) : (
          recentSessions.map((session, index) => {
            const statusInfo = getStatusInfo(session.status);
            return (
              <AnimatedPressable
                key={session.sessionId}
                style={styles.sessionCard}
                onPress={() => handleOpenSession(session.sessionId)}
              >
                {/* Thumbnail */}
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

                {/* Content */}
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

                {/* Status */}
                <View style={[styles.statusPill, { backgroundColor: statusInfo.bg }]}>
                  <View style={[styles.statusDotSmall, { backgroundColor: statusInfo.color }]} />
                  <Text style={[styles.statusLabel, { color: statusInfo.color }]}>
                    {statusInfo.label}
                  </Text>
                </View>
              </AnimatedPressable>
            );
          })
        )}
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
    paddingTop: 64,
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontFamily: fonts.display.bold,
    letterSpacing: -0.3,
  },
  headerStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  headerStat: {
    color: colors.textTertiary,
    fontSize: 13,
  },
  headerStatValue: {
    color: colors.textSecondary,
    fontWeight: '700',
  },
  headerStatDivider: {
    width: 1,
    height: 12,
    backgroundColor: colors.bgOverlay,
    marginHorizontal: spacing.md,
  },
  content: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },

  // Empty State
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

  // Session Card
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
    width: 56,
    height: 56,
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
    fontSize: 20,
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
  statusDotSmall: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
});
