import React, { useState, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated, Dimensions } from 'react-native';
import { colors, fonts, spacing, radii } from '../theme';
import { useFadeIn } from '../hooks/useFadeIn';
import { useAggregatedBooks } from '../hooks/useAggregatedBooks';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';
import { BooksListTab } from '../components/BooksListTab';
import { ScanningTab } from '../components/ScanningTab';

type SubTab = 'books' | 'scanning';

const SCREEN_WIDTH = Dimensions.get('window').width;
const TAB_AREA_WIDTH = SCREEN_WIDTH - spacing.xxl * 2;
const SUB_TAB_WIDTH = TAB_AREA_WIDTH / 2;

export function MyShelfScreen(): React.JSX.Element {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('books');
  const indicatorX = useRef(new Animated.Value(0)).current;
  const headerAnim = useFadeIn(0, 16);

  const { totalCount } = useAggregatedBooks();
  const activeScans = useBackgroundScanStore((s) => Object.keys(s.scans).length);

  const handleSelectTab = useCallback(
    (tab: SubTab) => {
      setActiveSubTab(tab);
      Animated.spring(indicatorX, {
        toValue: tab === 'books' ? 0 : SUB_TAB_WIDTH,
        tension: 68,
        friction: 12,
        useNativeDriver: true,
      }).start();
    },
    [indicatorX],
  );

  const statsText = [
    totalCount > 0 ? `${totalCount} book${totalCount === 1 ? '' : 's'}` : null,
    activeScans > 0 ? `${activeScans} scanning` : null,
  ]
    .filter(Boolean)
    .join('  \u00B7  ');

  return (
    <View style={styles.container}>
      {/* Header */}
      <Animated.View style={[styles.header, headerAnim]}>
        <Text style={styles.title}>My Shelf</Text>
        {statsText.length > 0 && (
          <Text style={styles.subtitle}>{statsText}</Text>
        )}
      </Animated.View>

      {/* Sub-tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={styles.tabItem}
          onPress={() => handleSelectTab('books')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.tabLabel,
              activeSubTab === 'books' && styles.tabLabelActive,
            ]}
          >
            Books
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.tabItem}
          onPress={() => handleSelectTab('scanning')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.tabLabel,
              activeSubTab === 'scanning' && styles.tabLabelActive,
            ]}
          >
            Scanning
          </Text>
        </TouchableOpacity>

        {/* Animated underline */}
        <Animated.View
          style={[
            styles.underline,
            { transform: [{ translateX: indicatorX }] },
          ]}
        />
      </View>

      {/* Content */}
      <View style={styles.content}>
        {activeSubTab === 'books' ? <BooksListTab /> : <ScanningTab />}
      </View>
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
    paddingBottom: spacing.lg,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontFamily: fonts.display.bold,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.textTertiary,
    fontSize: 13,
    marginTop: spacing.xs,
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: spacing.xxl,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
    position: 'relative',
  },
  tabItem: {
    width: SUB_TAB_WIDTH,
    alignItems: 'center',
    paddingBottom: spacing.md,
  },
  tabLabel: {
    color: colors.textTertiary,
    fontSize: 15,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  underline: {
    position: 'absolute',
    bottom: -1,
    width: SUB_TAB_WIDTH,
    height: 2,
    backgroundColor: colors.primary,
  },
  content: {
    flex: 1,
    marginTop: spacing.lg,
  },
});
