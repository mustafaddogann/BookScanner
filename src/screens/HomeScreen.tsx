import React, { useCallback, useMemo, useRef, useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  Image,
  Dimensions,
  Modal,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, ScanSession } from '../types';
import { useAppStore } from '../store/useAppStore';
import { launchImageLibrary } from 'react-native-image-picker';
import { colors, fonts, spacing, radii, shadows } from '../theme';
import { useFadeIn } from '../hooks/useFadeIn';
import { usePressScale } from '../hooks/usePressScale';
import { StatPill } from '../components/StatPill';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { ensureFileUri } from '../utils/fileUri';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed': return colors.verified;
    case 'error': return colors.rejected;
    case 'processing': return colors.primary;
    default: return colors.textTertiary;
  }
}

export function HomeScreen({ onOpenSettings }: HomeScreenProps): React.JSX.Element {
  const navigation = useNavigation<NavigationProp>();
  const sessions = useAppStore((state) => state.sessions);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImportUri, setPendingImportUri] = useState<string | null>(null);

  // Staggered entrance animations
  const heroAnim = useFadeIn(0, 20);
  const statsAnim = useFadeIn(100, 12);
  const buttonsAnim = useFadeIn(200, 12);
  const sectionAnim = useFadeIn(300, 12);

  // Gold glow pulse for primary button
  const glowAnim = useRef(new Animated.Value(0.15)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 0.45, duration: 2000, useNativeDriver: false }),
        Animated.timing(glowAnim, { toValue: 0.15, duration: 2000, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glowAnim]);

  // Keep this JS-driven to avoid mixing with glowAnim (shadowOpacity is JS-only).
  const scanPress = usePressScale(0.96, false);

  const recentSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime();
      const timeB = new Date(b.createdAt).getTime();
      return timeB - timeA;
    });
    return sorted.slice(0, 5);
  }, [sessions]);

  // Stats
  const totalBooks = useMemo(() => {
    return sessions.reduce((sum, s) => sum + (s.detectionCount || 0), 0);
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

      if (result.didCancel) return;

      if (result.errorCode) {
        setImportError(result.errorMessage || 'Unable to open photo library.');
        return;
      }

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setImportError('No photo selected.');
        return;
      }

      setPendingImportUri(asset.uri);
    } catch (error: any) {
      setImportError(error?.message || 'Failed to import photo.');
    }
  }, []);

  const handleConfirmImport = useCallback(() => {
    if (!pendingImportUri) return;
    const uri = pendingImportUri;
    setPendingImportUri(null);
    navigation.navigate('Scanner', { importUri: uri });
  }, [pendingImportUri, navigation]);

  const handleCancelImport = useCallback(() => {
    setPendingImportUri(null);
  }, []);

  const handleOpenSession = useCallback((sessionId: string) => {
    navigation.navigate('Results', { sessionId });
  }, [navigation]);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero Section */}
        <Animated.View style={[styles.hero, heroAnim]}>
          <View style={styles.heroTop}>
            <View>
              <Text style={styles.heroTitle}>ShelfScan</Text>
              <Text style={styles.heroSubtitle}>Your personal library scanner</Text>
            </View>
            <TouchableOpacity
              onPress={handleSettings}
              style={styles.settingsButton}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <View style={styles.settingsCircle}>
                <Text style={styles.settingsIcon}>&#9881;</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Stats Row */}
          <Animated.View style={[styles.statsRow, statsAnim]}>
            <StatPill value={sessions.length} label="Scans" />
            <StatPill value={totalBooks} label="Books" color={colors.verified} />
          </Animated.View>
        </Animated.View>

        {/* Action Buttons */}
        <Animated.View style={[styles.buttonsSection, buttonsAnim]}>
          <Animated.View style={[
            scanPress.animatedStyle,
            { shadowOpacity: glowAnim, shadowColor: colors.primary, shadowOffset: { width: 0, height: 0 }, shadowRadius: 20 },
          ]}>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleScan}
              onPressIn={scanPress.onPressIn}
              onPressOut={scanPress.onPressOut}
              activeOpacity={1}
            >
              <View style={styles.primaryButtonContent}>
                <Text style={styles.primaryButtonIcon}>{'\u25CE'}</Text>
                <Text style={styles.primaryButtonText}>Scan shelf</Text>
              </View>
            </TouchableOpacity>
          </Animated.View>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={handleImport}
            activeOpacity={0.7}
          >
            <Text style={styles.secondaryButtonIcon}>{'\u2B9E'}</Text>
            <Text style={styles.secondaryButtonText}>Import photo</Text>
          </TouchableOpacity>
        </Animated.View>

        {importError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{importError}</Text>
          </View>
        )}

        {/* Recent Sessions */}
        <Animated.View style={[styles.sessionsSection, sectionAnim]}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent</Text>
            {sessions.length > 3 && (
              <Text style={styles.sectionLink}>See all</Text>
            )}
          </View>

          {recentSessions.length === 0 ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconContainer}>
                <Text style={styles.emptyIcon}>{'\u{1F4DA}'}</Text>
              </View>
              <Text style={styles.emptyTitle}>Start your collection</Text>
              <Text style={styles.emptySubtext}>
                Point your camera at a bookshelf and tap scan.{'\n'}We'll identify every spine.
              </Text>
            </View>
          ) : (
            recentSessions.map((session, index) => {
              const statusColor = getStatusColor(session.status);
              return (
                <AnimatedPressable
                  key={session.sessionId}
                  style={[
                    styles.sessionCard,
                    index === 0 ? styles.sessionCardFirst : undefined,
                  ]}
                  onPress={() => handleOpenSession(session.sessionId)}
                >
                  {/* Thumbnail */}
                  <View style={styles.sessionThumb}>
                    {session.imagePath ? (
                      <Image
                        source={{ uri: ensureFileUri(session.imagePath) }}
                        style={styles.sessionThumbImage}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={styles.sessionThumbPlaceholder}>
                        <Text style={styles.sessionThumbPlaceholderIcon}>{'\u{1F4F7}'}</Text>
                      </View>
                    )}
                  </View>

                  {/* Info */}
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

                  {/* Status indicator */}
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                </AnimatedPressable>
              );
            })
          )}
        </Animated.View>
      </ScrollView>

      {/* Import Confirmation Modal */}
      <Modal
        visible={!!pendingImportUri}
        animationType="fade"
        transparent={true}
        onRequestClose={handleCancelImport}
      >
        <View style={styles.importOverlay}>
          <View style={styles.importCard}>
            {/* Preview Image */}
            <View style={styles.importPreviewContainer}>
              {pendingImportUri && (
                <Image
                  source={{ uri: pendingImportUri }}
                  style={styles.importPreviewImage}
                  resizeMode="contain"
                />
              )}
            </View>

            {/* Actions */}
            <View style={styles.importActions}>
              <Text style={styles.importTitle}>Scan this photo?</Text>
              <Text style={styles.importHint}>
                The image will be analyzed for book spines
              </Text>
              <TouchableOpacity
                style={styles.importConfirmButton}
                onPress={handleConfirmImport}
                activeOpacity={0.8}
              >
                <Text style={styles.importConfirmText}>Scan Photo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.importCancelButton}
                onPress={handleCancelImport}
                activeOpacity={0.7}
              >
                <Text style={styles.importCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  scrollContent: {
    paddingBottom: spacing.xxxxl,
  },

  // Hero
  hero: {
    paddingTop: 64,
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxl,
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  heroTitle: {
    color: colors.textPrimary,
    fontSize: 36,
    fontFamily: fonts.display.bold,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    color: colors.textTertiary,
    fontSize: 15,
    marginTop: 4,
    letterSpacing: 0.2,
  },
  settingsButton: {
    marginTop: 4,
  },
  settingsCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingsIcon: {
    color: colors.textSecondary,
    fontSize: 18,
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: spacing.xxl,
  },

  // Buttons
  buttonsSection: {
    paddingHorizontal: spacing.xxl,
    marginBottom: spacing.xxl,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.xl,
    height: 58,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  primaryButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  primaryButtonIcon: {
    color: colors.bgDeep,
    fontSize: 18,
  },
  primaryButtonText: {
    color: colors.bgDeep,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  secondaryButton: {
    backgroundColor: colors.transparent,
    borderRadius: radii.xl,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.bgOverlay,
    flexDirection: 'row',
    gap: 8,
  },
  secondaryButtonIcon: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },

  // Error
  errorBanner: {
    marginHorizontal: spacing.xxl,
    backgroundColor: 'rgba(199, 92, 92, 0.12)',
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(199, 92, 92, 0.2)',
  },
  errorText: {
    color: colors.rejected,
    fontSize: 13,
    textAlign: 'center',
  },

  // Sessions Section
  sessionsSection: {
    paddingHorizontal: spacing.xxl,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  sectionLink: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '600',
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
  emptyIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  emptyIcon: {
    fontSize: 28,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.sm,
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },

  // Session Cards
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
  sessionCardFirst: {
    borderColor: colors.primaryMuted,
  },
  sessionThumb: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.bgNested,
  },
  sessionThumbImage: {
    width: '100%',
    height: '100%',
  },
  sessionThumbPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sessionThumbPlaceholderIcon: {
    fontSize: 20,
  },
  sessionInfo: {
    flex: 1,
    marginLeft: spacing.lg,
    marginRight: spacing.md,
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
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  // Import confirmation modal
  importOverlay: {
    flex: 1,
    backgroundColor: 'rgba(12, 10, 9, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
  },
  importCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xxl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    ...shadows.elevated,
  },
  importPreviewContainer: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: colors.bgDeep,
  },
  importPreviewImage: {
    width: '100%',
    height: '100%',
  },
  importActions: {
    padding: spacing.xxl,
    alignItems: 'center',
  },
  importTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  importHint: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 20,
  },
  importConfirmButton: {
    width: '100%',
    backgroundColor: colors.primary,
    borderRadius: radii.lg,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: spacing.md,
    ...shadows.glowSubtle,
  },
  importConfirmText: {
    color: colors.bgDeep,
    fontSize: 16,
    fontWeight: '700',
  },
  importCancelButton: {
    width: '100%',
    paddingVertical: 12,
    alignItems: 'center',
  },
  importCancelText: {
    color: colors.textSecondary,
    fontSize: 15,
  },
});
