// Opens the right screen for a deep link or a tapped push: the relay screen for a pairing QR code
// (lumenconsole://relay?url=…&code=…), and the server or node for a relay push
// (lumenconsole://alert?origin=…&server=…). Renders nothing.

import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';

import { useNav, type Route, type Tab } from '../navigation';
import { useApp } from '../state/AppProvider';
import { parseLink, routeForLink } from './links';

export function LinkHandler() {
  const { panels, selectPanel } = useApp();
  const nav = useNav();
  const [pending, setPending] = useState<{ tab: Tab; route?: Route } | null>(null);
  // Read through refs, so the listeners are set up once and the start-up link is opened once.
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const selectRef = useRef(selectPanel);
  selectRef.current = selectPanel;

  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const link = parseLink(url);
      const target = link ? routeForLink(link, panelsRef.current) : null;
      if (!target) return;
      if (target.panelId) selectRef.current(target.panelId);
      setPending({ tab: target.tab, route: target.route });
    };
    void Linking.getInitialURL().then(open).catch(() => undefined);
    const sub = Linking.addEventListener('url', (event) => open(event.url));
    let response: { remove(): void } | null = null;
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      const urlOf = (r: Notifications.NotificationResponse | null) => {
        const data = r?.notification.request.content.data as { url?: unknown } | undefined;
        return typeof data?.url === 'string' ? data.url : null;
      };
      void Notifications.getLastNotificationResponseAsync().then((r) => open(urlOf(r))).catch(() => undefined);
      response = Notifications.addNotificationResponseReceivedListener((r) => open(urlOf(r)));
    }
    return () => {
      sub.remove();
      response?.remove();
    };
  }, []);

  // The stack of a tab can only be pushed once that tab is open.
  useEffect(() => {
    if (!pending) return;
    if (nav.tab !== pending.tab) {
      nav.setTab(pending.tab);
      return;
    }
    if (pending.route) nav.push(pending.route);
    setPending(null);
  }, [pending, nav]);

  return null;
}
