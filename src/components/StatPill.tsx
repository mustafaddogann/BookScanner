/**
 * StatPill - Animated stat counter with label
 *
 * Compact stat display: count animates up from 0 on mount.
 * Used in home screen hero area and results header.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { colors, fonts, radii, spacing } from '../theme';

interface StatPillProps {
  value: number;
  label: string;
  color?: string;
  style?: ViewStyle;
}

export function StatPill({ value, label, color = colors.primary, style }: StatPillProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const animRef = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (value === 0) {
      setDisplayValue(0);
      return;
    }

    animRef.setValue(0);
    const listener = animRef.addListener(({ value: v }) => {
      setDisplayValue(Math.round(v));
    });

    Animated.timing(animRef, {
      toValue: value,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();

    return () => {
      animRef.removeListener(listener);
    };
  }, [value, animRef]);

  return (
    <View style={[styles.container, style]}>
      <Text style={[styles.value, { color }]}>{displayValue}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minWidth: 80,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  value: {
    fontSize: 24,
    fontFamily: fonts.display.bold,
    marginBottom: 2,
  },
  label: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
