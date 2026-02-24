/**
 * ShimmerPlaceholder - Skeleton loading with shimmer effect
 *
 * Airbnb-style content placeholder that shimmers while loading.
 * Use as a placeholder for cards, text blocks, thumbnails.
 */

import React from 'react';
import { Animated, StyleSheet, View, type ViewStyle } from 'react-native';
import { useShimmer } from '../hooks/useShimmer';
import { colors, radii } from '../theme';

interface ShimmerPlaceholderProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export function ShimmerPlaceholder({
  width = '100%',
  height = 16,
  borderRadius = radii.sm,
  style,
}: ShimmerPlaceholderProps) {
  const shimmer = useShimmer();

  const backgroundColor = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.shimmerBase, colors.shimmerHighlight],
  });

  return (
    <Animated.View
      style={[
        styles.base,
        { width: width as number, height, borderRadius, backgroundColor },
        style,
      ]}
    />
  );
}

/** Pre-built skeleton for a session card */
export function SessionCardSkeleton() {
  return (
    <View style={styles.cardSkeleton}>
      <ShimmerPlaceholder width={64} height={48} borderRadius={radii.sm} />
      <View style={styles.cardSkeletonText}>
        <ShimmerPlaceholder width="70%" height={14} />
        <ShimmerPlaceholder width="40%" height={10} style={{ marginTop: 8 }} />
      </View>
    </View>
  );
}

/** Pre-built skeleton for a book candidate card */
export function BookCardSkeleton() {
  return (
    <View style={styles.bookSkeleton}>
      <View style={styles.bookSkeletonRow}>
        <ShimmerPlaceholder width="50%" height={14} />
        <ShimmerPlaceholder width={48} height={20} borderRadius={radii.pill} />
      </View>
      <ShimmerPlaceholder width="80%" height={18} style={{ marginTop: 10 }} />
      <ShimmerPlaceholder width="60%" height={12} style={{ marginTop: 8 }} />
      <ShimmerPlaceholder height={3} borderRadius={2} style={{ marginTop: 12 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
  cardSkeleton: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    padding: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardSkeletonText: {
    flex: 1,
    marginLeft: 12,
  },
  bookSkeleton: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    padding: 16,
    marginBottom: 12,
  },
  bookSkeletonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
