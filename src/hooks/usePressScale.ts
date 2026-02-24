import { useRef, useCallback } from 'react';
import { Animated } from 'react-native';

/**
 * Spring-based press scale animation for interactive elements.
 * Returns scale animated value + onPressIn/onPressOut handlers.
 *
 * @param scaleDown - scale factor when pressed (default 0.97)
 */
export function usePressScale(scaleDown = 0.97) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.spring(scale, {
      toValue: scaleDown,
      tension: 100,
      friction: 8,
      useNativeDriver: true,
    }).start();
  }, [scale, scaleDown]);

  const onPressOut = useCallback(() => {
    Animated.spring(scale, {
      toValue: 1,
      tension: 80,
      friction: 6,
      useNativeDriver: true,
    }).start();
  }, [scale]);

  return {
    scale,
    animatedStyle: { transform: [{ scale }] },
    onPressIn,
    onPressOut,
  };
}
