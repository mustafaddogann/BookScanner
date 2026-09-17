import React, { useState, useCallback, useRef, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Animated, Dimensions } from 'react-native';
import { HomeScreen } from './HomeScreen';
import { MyShelfScreen } from './MyShelfScreen';
import { SettingsScreen } from './SettingsScreen';
import { colors, spacing, radii, shadows } from '../theme';
import { useUnreviewedStore } from '../store/useUnreviewedStore';
import { useBackgroundScanStore } from '../store/useBackgroundScanStore';

type TabKey = 'Scan' | 'MyShelf' | 'Settings';

const TAB_BAR_HEIGHT = 72;
const TAB_BAR_MARGIN = 20;
const SCREEN_WIDTH = Dimensions.get('window').width;
const TAB_BAR_WIDTH = SCREEN_WIDTH - TAB_BAR_MARGIN * 2;
const TAB_COUNT = 3;
const TAB_WIDTH = TAB_BAR_WIDTH / TAB_COUNT;

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'Scan', label: 'Scan', icon: '\u25CE' },            // ◎
  { key: 'MyShelf', label: 'My Shelf', icon: '\u{1F4DA}' },  // 📚
  { key: 'Settings', label: 'Settings', icon: '\u2699' },    // ⚙
];

export function TabsScreen(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>('Scan');
  const indicatorX = useRef(new Animated.Value(0)).current;
  const unreviewedCount = useUnreviewedStore((s) => s.unreviewedIds.size);
  const activeScanCount = useBackgroundScanStore((s) => Object.keys(s.scans).length);

  const handleSelectTab = useCallback((tab: TabKey) => {
    setActiveTab(tab);
    const index = TABS.findIndex(t => t.key === tab);
    Animated.spring(indicatorX, {
      toValue: index * TAB_WIDTH,
      tension: 68,
      friction: 12,
      useNativeDriver: true,
    }).start();
  }, [indicatorX]);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {activeTab === 'Scan' && (
          <HomeScreen onOpenSettings={() => handleSelectTab('Settings')} />
        )}
        {activeTab === 'MyShelf' && <MyShelfScreen />}
        {activeTab === 'Settings' && (
          <SettingsScreen onBack={() => handleSelectTab('Scan')} />
        )}
      </View>

      {/* Floating glass tab bar */}
      <View style={styles.tabBarContainer}>
        <View style={styles.tabBar}>
          {/* Sliding active indicator */}
          <Animated.View
            style={[
              styles.activeIndicator,
              { transform: [{ translateX: indicatorX }] },
            ]}
          >
            <View style={styles.activeIndicatorInner} />
          </Animated.View>

          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <TouchableOpacity
                key={tab.key}
                style={styles.tabItem}
                onPress={() => handleSelectTab(tab.key)}
                activeOpacity={0.7}
              >
                <View style={styles.tabIconWrapper}>
                  <Text style={[styles.tabIcon, isActive && styles.tabIconActive]}>
                    {tab.icon}
                  </Text>
                  {tab.key === 'MyShelf' && (activeScanCount > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>
                        {activeScanCount > 99 ? '99+' : activeScanCount}
                      </Text>
                    </View>
                  ) : unreviewedCount > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>
                        {unreviewedCount > 99 ? '99+' : unreviewedCount}
                      </Text>
                    </View>
                  ) : null)}
                </View>
                <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },
  content: {
    flex: 1,
    paddingBottom: TAB_BAR_HEIGHT + TAB_BAR_MARGIN + 8,
  },
  tabBarContainer: {
    position: 'absolute',
    bottom: TAB_BAR_MARGIN,
    left: TAB_BAR_MARGIN,
    right: TAB_BAR_MARGIN,
  },
  tabBar: {
    height: TAB_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.glassBg,
    borderRadius: radii.xxxl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    ...shadows.float,
    overflow: 'hidden',
  },
  activeIndicator: {
    position: 'absolute',
    width: TAB_WIDTH,
    height: TAB_BAR_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  activeIndicatorInner: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.primaryMuted,
    borderRadius: radii.xxl,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    zIndex: 1,
  },
  tabIconWrapper: {
    position: 'relative' as const,
  },
  tabIcon: {
    color: colors.textMuted,
    fontSize: 18,
    marginBottom: 3,
  },
  badge: {
    position: 'absolute' as const,
    top: -4,
    right: -10,
    backgroundColor: colors.primary,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 4,
  },
  badgeText: {
    color: colors.bgDeep,
    fontSize: 10,
    fontWeight: '700' as const,
  },
  tabIconActive: {
    color: colors.primary,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  tabTextActive: {
    color: colors.primary,
  },
});
