// Deep links: lumenconsole://relay?url=…&code=… (pairing QR code from `lumen-relay pair`) and
// lumenconsole://alert?origin=…&server=… or &node=… (a tapped relay push).

import type { Route, Tab } from '../navigation';

export type AppLink =
  | { kind: 'relay'; url: string; code: string }
  | { kind: 'alert'; origin: string; server?: string; node?: number };

function query(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      // a broken escape: skipped
    }
  }
  return out;
}

export function parseLink(url: string | null | undefined): AppLink | null {
  if (!url) return null;
  const match = /^lumenconsole:\/\/([a-z]+)\/?(?:\?([^#]*))?/i.exec(url.trim());
  if (!match) return null;
  const q = query(match[2] ?? '');
  switch (match[1].toLowerCase()) {
    case 'relay':
      return q.url ? { kind: 'relay', url: q.url, code: q.code ?? '' } : null;
    case 'alert': {
      if (!q.origin || !/^https:\/\//.test(q.origin)) return null;
      const node = q.node !== undefined && /^\d+$/.test(q.node) ? Number(q.node) : undefined;
      const server = q.server && /^[A-Za-z0-9-]{1,64}$/.test(q.server) ? q.server : undefined;
      return { kind: 'alert', origin: q.origin.replace(/\/+$/, ''), server, node };
    }
    default:
      return null;
  }
}

/** Where a link leads: the tab, the screen on it, and the panel to select first. */
export function routeForLink(link: AppLink, panels: { id: string; origin: string }[]): { tab: Tab; route?: Route; panelId?: string } | null {
  if (link.kind === 'relay') return { tab: 'settings', route: { name: 'relay', url: link.url, code: link.code } };
  const panel = panels.find((p) => p.origin === link.origin);
  if (!panel) return null;
  if (link.server) return { tab: 'servers', route: { name: 'server', id: link.server }, panelId: panel.id };
  if (link.node !== undefined) return { tab: 'admin', route: { name: 'adminNode', id: link.node }, panelId: panel.id };
  return { tab: 'alerts', panelId: panel.id };
}
