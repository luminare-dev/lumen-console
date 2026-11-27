import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { NavigationProvider, useNav, type Tab } from './src/navigation';
import { AdminScreen, AdminServerScreen, AdminServersScreen, AdminUserFormScreen, AdminUserScreen, AdminUsersScreen } from './src/screens/admin';
import { AlertsScreen } from './src/screens/alerts';
import { ConnectScreen, PanelSettingsScreen, PanelsScreen } from './src/screens/connect';
import { ConsoleScreen } from './src/screens/console';
import { FileScreen, FilesScreen } from './src/screens/files';
import { AdminLocationsScreen, AdminNestScreen, AdminNestsScreen, AdminNodeScreen, AdminNodesScreen } from './src/screens/nodes';
import { BackupsScreen, DatabasesScreen, NetworkScreen, SchedulesScreen, StartupScreen, SubusersScreen } from './src/screens/server-more';
import { ServerScreen, ServersScreen } from './src/screens/servers';
import { AccountScreen, SettingsScreen, TokensScreen } from './src/screens/settings';
import { AppProvider, useApp } from './src/state/AppProvider';
import { Loading, styles, T } from './src/ui/kit';

type TabLabel = 'tab.servers' | 'tab.admin' | 'tab.alerts' | 'tab.settings';

const TABS: { tab: Tab; label: TabLabel; icon: string }[] = [
  { tab: 'servers', label: 'tab.servers', icon: '▤' },
  { tab: 'admin', label: 'tab.admin', icon: '◈' },
  { tab: 'alerts', label: 'tab.alerts', icon: '△' },
  { tab: 'settings', label: 'tab.settings', icon: '⚙' },
];

function TabBar() {
  const { t, theme, active } = useApp();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  // The admin tab is there for panels with an application key or a root-admin account.
  const tabs = TABS.filter(({ tab }) => tab !== 'admin' || active?.hasApplicationKey || active?.rootAdmin);
  return (
    <View
      role="tablist"
      style={[
        styles.row,
        {
          backgroundColor: theme.color.surface,
          borderTopWidth: 1,
          borderTopColor: theme.color.border,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {tabs.map(({ tab, label, icon }) => {
        const selected = nav.tab === tab;
        const color = selected ? theme.color.accentText : theme.color.textMuted;
        return (
          <Pressable
            key={tab}
            role="tab"
            aria-selected={selected}
            aria-label={t(label)}
            onPress={() => nav.setTab(tab)}
            testID={`tab-${tab}`}
            style={{ flex: 1, alignItems: 'center', paddingVertical: theme.space(2.5), gap: 2 }}
          >
            <T variant="heading" style={{ color, lineHeight: 22 }}>
              {icon}
            </T>
            <T variant="caption" style={{ color, fontWeight: selected ? '700' : '500' }}>
              {t(label)}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

function CurrentScreen() {
  const { route, pop } = useNav();
  switch (route.name) {
    case 'servers':
      return <ServersScreen />;
    case 'server':
      return <ServerScreen id={route.id} />;
    case 'console':
      return <ConsoleScreen id={route.id} />;
    case 'files':
      return <FilesScreen id={route.id} dir={route.dir} />;
    case 'file':
      return <FileScreen id={route.id} path={route.path} />;
    case 'databases':
      return <DatabasesScreen id={route.id} />;
    case 'schedules':
      return <SchedulesScreen id={route.id} />;
    case 'backups':
      return <BackupsScreen id={route.id} />;
    case 'network':
      return <NetworkScreen id={route.id} />;
    case 'startup':
      return <StartupScreen id={route.id} />;
    case 'subusers':
      return <SubusersScreen id={route.id} />;
    case 'admin':
      return <AdminScreen />;
    case 'adminUsers':
      return <AdminUsersScreen />;
    case 'adminUser':
      return <AdminUserScreen id={route.id} />;
    case 'adminUserForm':
      return <AdminUserFormScreen id={route.id} />;
    case 'adminServers':
      return <AdminServersScreen />;
    case 'adminServer':
      return <AdminServerScreen id={route.id} />;
    case 'adminNodes':
      return <AdminNodesScreen />;
    case 'adminNode':
      return <AdminNodeScreen id={route.id} />;
    case 'adminLocations':
      return <AdminLocationsScreen />;
    case 'adminNests':
      return <AdminNestsScreen />;
    case 'adminNest':
      return <AdminNestScreen id={route.id} />;
    case 'alerts':
      return <AlertsScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'panels':
      return <PanelsScreen />;
    case 'connect':
      return <ConnectScreen onBack={pop} onDone={pop} />;
    case 'panelSettings':
      return <PanelSettingsScreen id={route.id} />;
    case 'account':
      return <AccountScreen />;
    case 'tokens':
      return <TokensScreen />;
  }
}

function Shell() {
  const { ready, panels, theme, language } = useApp();

  // The page language and background follow the app on the web.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.documentElement.lang = language;
    document.documentElement.style.colorScheme = theme.mode;
    document.body.style.backgroundColor = theme.color.canvas;
  }, [language, theme]);

  return (
    <View style={[styles.fill, { backgroundColor: theme.color.canvas }]}>
      <StatusBar style={theme.mode === 'dark' ? 'light' : 'dark'} />
      {!ready ? (
        <Loading />
      ) : panels.length === 0 ? (
        <ConnectScreen />
      ) : (
        <NavigationProvider>
          <View style={styles.fill}>
            <CurrentScreen />
          </View>
          <TabBar />
        </NavigationProvider>
      )}
    </View>
  );
}

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ Sora: require('./assets/fonts/Sora-Variable.ttf') as number });
  if (!fontsLoaded && !fontError) return null;
  return (
    <SafeAreaProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </SafeAreaProvider>
  );
}
