import { useRef, useEffect } from 'react';
import { Animated, Easing } from 'react-native';

/**
 * Shimmer animation for skeleton loading states.
 * Returns an animated value that oscillates 0→1→0 continuously.
 */
export function useShimmer(duration = 1200) {
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, {
          toValue: 1,
          duration: duration / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(shimmer, {
          toValue: 0,
          duration: duration / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer, duration]);

  return shimmer;
}
