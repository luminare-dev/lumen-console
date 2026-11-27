import { useEffect } from 'react';

import type { ClientServer, PowerState, ServerStatus } from '../api/types';
import type { Translate } from '../i18n';
import { useApp } from '../state/AppProvider';
import { useResource, type Resource } from '../state/useResource';
import type { Tone } from '../ui/kit';

/** The server view (with the daemon type on Hydrodactyl), cached per panel. */
export function useServer(id: string): Resource<ClientServer> {
  const { client } = useApp();
  return useResource(client, `server:${id}`, (c) => c.server(id));
}

/** Calls `reload` every `ms` while the screen is open. */
export function usePolling(reload: () => void, ms: number, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(reload, ms);
    return () => clearInterval(timer);
  }, [reload, ms, enabled]);
}

export function stateBadge(t: Translate, state: PowerState | undefined, status: ServerStatus | undefined, unreachable = false): { label: string; tone: Tone } {
  if (status === 'suspended') return { label: t('server.suspended'), tone: 'danger' };
  if (status === 'installing') return { label: t('server.installing'), tone: 'info' };
  if (status === 'install_failed' || status === 'reinstall_failed') return { label: t('server.installFailed'), tone: 'danger' };
  if (status === 'restoring_backup') return { label: t('server.restoring'), tone: 'info' };
  if (unreachable) return { label: t('server.unreachable'), tone: 'warning' };
  switch (state) {
    case 'running':
      return { label: t('server.running'), tone: 'success' };
    case 'starting':
      return { label: t('server.starting'), tone: 'warning' };
    case 'stopping':
      return { label: t('server.stopping'), tone: 'warning' };
    case 'offline':
      return { label: t('server.offline'), tone: 'neutral' };
    default:
      return { label: '…', tone: 'neutral' };
  }
}

/** Percent of a MiB limit; undefined when the limit is unlimited (0). */
export function percentOf(bytes: number | undefined, limitMiB: number): number | undefined {
  if (bytes === undefined || !limitMiB) return undefined;
  return (bytes / (limitMiB * 1024 * 1024)) * 100;
}

export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`.replace(/^\/*/, '/');
}

export function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
}
