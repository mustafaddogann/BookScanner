/**
 * AnimatedPressable - TouchableOpacity with spring-based press scale
 *
 * Drop-in replacement that adds a satisfying press-down spring animation.
 * Used for cards, buttons, and any interactive surface.
 */

import React from 'react';
import { Animated, TouchableOpacity, type TouchableOpacityProps, type StyleProp, type ViewStyle } from 'react-native';
import { usePressScale } from '../hooks/usePressScale';

interface AnimatedPressableProps extends Omit<TouchableOpacityProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  scaleDown?: number;
  children: React.ReactNode;
}

export function AnimatedPressable({
  style,
  scaleDown = 0.97,
  children,
  onPressIn: externalPressIn,
  onPressOut: externalPressOut,
  ...rest
}: AnimatedPressableProps) {
  const { animatedStyle, onPressIn, onPressOut } = usePressScale(scaleDown);

  return (
    <Animated.View style={[animatedStyle, style]}>
      <TouchableOpacity
        activeOpacity={1}
        onPressIn={(e) => {
          onPressIn();
          externalPressIn?.(e);
        }}
        onPressOut={(e) => {
          onPressOut();
          externalPressOut?.(e);
        }}
        {...rest}
      >
        {children}
      </TouchableOpacity>
    </Animated.View>
  );
}
