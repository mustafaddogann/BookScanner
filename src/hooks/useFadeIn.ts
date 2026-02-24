import { useRef, useEffect } from 'react';
import { Animated, Easing } from 'react-native';

/**
 * Reusable fade + slide-up entrance animation with spring physics.
 *
 * @param delay - ms delay before animation starts (useful for staggering)
 * @param distance - translateY distance in px (default 16)
 * @returns { opacity, transform } style to spread onto an Animated.View
 */
export function useFadeIn(delay = 0, distance = 16) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(distance)).current;

  useEffect(() => {
    const animation = Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 500,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        delay,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }),
    ]);

    animation.start();

    return () => animation.stop();
  }, [delay, distance, opacity, translateY]);

  return {
    opacity,
    transform: [{ translateY }],
  };
}
