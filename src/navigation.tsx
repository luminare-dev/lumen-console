// A small stack navigator per tab. The app has no deep links, so a router dependency would add
// more than it saves. Android's back button pops the stack.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler } from 'react-native';

export type Tab = 'servers' | 'admin' | 'alerts' | 'settings';

export type Route =
  // Servers (Client API)
  | { name: 'servers' }
  | { name: 'server'; id: string }
  | { name: 'console'; id: string }
  | { name: 'files'; id: string; dir: string }
  | { name: 'file'; id: string; path: string }
  | { name: 'databases'; id: string }
  | { name: 'schedules'; id: string }
  | { name: 'backups'; id: string }
  | { name: 'network'; id: string }
  | { name: 'startup'; id: string }
  | { name: 'subusers'; id: string }
  // Admin (Application API)
  | { name: 'admin' }
  | { name: 'adminUsers' }
  | { name: 'adminUser'; id: number }
  | { name: 'adminUserForm'; id?: number }
  | { name: 'adminServers' }
  | { name: 'adminServer'; id: number }
  | { name: 'adminNodes' }
  | { name: 'adminNode'; id: number }
  | { name: 'adminLocations' }
  | { name: 'adminNests' }
  | { name: 'adminNest'; id: number }
  // Alerts and settings
  | { name: 'alerts' }
  | { name: 'settings' }
  | { name: 'panels' }
  | { name: 'connect' }
  | { name: 'panelSettings'; id: string }
  | { name: 'account' }
  | { name: 'tokens' };

export interface Navigation {
  tab: Tab;
  route: Route;
  depth: number;
  push(route: Route): void;
  pop(): void;
  setTab(tab: Tab): void;
}

const NavContext = createContext<Navigation | null>(null);

export function useNav(): Navigation {
  const value = useContext(NavContext);
  if (!value) throw new Error('useNav outside NavigationProvider');
  return value;
}

const ROOTS: Record<Tab, Route[]> = {
  servers: [{ name: 'servers' }],
  admin: [{ name: 'admin' }],
  alerts: [{ name: 'alerts' }],
  settings: [{ name: 'settings' }],
};

export function NavigationProvider({ children, initialTab = 'servers' }: { children: ReactNode; initialTab?: Tab }) {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [stacks, setStacks] = useState<Record<Tab, Route[]>>(ROOTS);
  const stack = stacks[tab];

  const push = useCallback((route: Route) => setStacks((s) => ({ ...s, [tab]: [...s[tab], route] })), [tab]);
  const pop = useCallback(() => setStacks((s) => (s[tab].length > 1 ? { ...s, [tab]: s[tab].slice(0, -1) } : s)), [tab]);
  const setTab = useCallback(
    (next: Tab) => {
      // Tapping the open tab again goes back to its first screen.
      if (next === tab) setStacks((s) => ({ ...s, [tab]: s[tab].slice(0, 1) }));
      setTabState(next);
    },
    [tab]
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        pop();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, pop]);

  const value = useMemo(() => ({ tab, route: stack[stack.length - 1], depth: stack.length, push, pop, setTab }), [tab, stack, push, pop, setTab]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
