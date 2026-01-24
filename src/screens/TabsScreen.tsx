import React, { useState, useCallback } from 'react';
import { StyleSheet, View, Text, TouchableOpacity } from 'react-native';
import { HomeScreen } from './HomeScreen';
import { SessionsScreen } from './SessionsScreen';
import { SettingsScreen } from './SettingsScreen';

type TabKey = 'Scan' | 'Sessions' | 'Settings';

const TAB_BAR_HEIGHT = 58;

export function TabsScreen(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>('Scan');

  const handleSelectTab = useCallback((tab: TabKey) => {
    setActiveTab(tab);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {activeTab === 'Scan' && (
          <HomeScreen onOpenSettings={() => handleSelectTab('Settings')} />
        )}
        {activeTab === 'Sessions' && <SessionsScreen />}
        {activeTab === 'Settings' && (
          <SettingsScreen onBack={() => handleSelectTab('Scan')} />
        )}
      </View>
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'Scan' && styles.tabItemActive]}
          onPress={() => handleSelectTab('Scan')}
        >
          <Text style={[styles.tabText, activeTab === 'Scan' && styles.tabTextActive]}>
            Scan
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'Sessions' && styles.tabItemActive]}
          onPress={() => handleSelectTab('Sessions')}
        >
          <Text style={[styles.tabText, activeTab === 'Sessions' && styles.tabTextActive]}>
            Sessions
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'Settings' && styles.tabItemActive]}
          onPress={() => handleSelectTab('Settings')}
        >
          <Text style={[styles.tabText, activeTab === 'Settings' && styles.tabTextActive]}>
            Settings
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  content: {
    flex: 1,
    paddingBottom: TAB_BAR_HEIGHT,
  },
  tabBar: {
    height: TAB_BAR_HEIGHT,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    borderTopWidth: 1,
    borderTopColor: '#2c2c2e',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  tabItemActive: {
    backgroundColor: '#2c2c2e',
  },
  tabText: {
    color: '#8e8e93',
    fontSize: 12,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#007AFF',
  },
});
