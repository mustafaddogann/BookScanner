import { useRef, useCallback } from 'react';
import { Animated } from 'react-native';

/**
 * Spring-based press scale animation for interactive elements.
 * Returns scale animated value + onPressIn/onPressOut handlers.
 *
 * @param scaleDown - scale factor when pressed (default 0.97)
 * @param useNativeDriver - set false when combining with JS-only animated props (e.g. shadowOpacity)
 */
export function usePressScale(scaleDown = 0.97, useNativeDriver = true) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.spring(scale, {
      toValue: scaleDown,
      tension: 100,
      friction: 8,
      useNativeDriver,
    }).start();
  }, [scale, scaleDown, useNativeDriver]);

  const onPressOut = useCallback(() => {
    Animated.spring(scale, {
      toValue: 1,
      tension: 80,
      friction: 6,
      useNativeDriver,
    }).start();
  }, [scale, useNativeDriver]);

  return {
    scale,
    animatedStyle: { transform: [{ scale }] },
    onPressIn,
    onPressOut,
  };
}
