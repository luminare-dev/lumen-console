// Daemon tokens read from the panel (GET /api/application/nodes/{id}/configuration) live only in
// this in-memory cache while the app runs: never saved, logged or shown. They are dropped when the
// panel or its application key is removed or replaced, and fetched again after a restart or when
// Wings rejects one. A token an admin pasted for a node (in the keychain) takes precedence.

import type { ApplicationApi } from '../api/application';
import { classifyFetchError, PanelError } from '../api/errors';
import type { PanelEntry } from './panels';
import { secretName, type SecretStore } from './secrets';

export interface DaemonTokenCache {
  /** The cached token, or the one `fetchToken` returns; parallel calls share one request. */
  get(panelId: string, nodeId: number, fetchToken: () => Promise<string>): Promise<string>;
  has(panelId: string, nodeId: number): boolean;
  /** Drops one node's token, or every token of the panel. */
  forget(panelId: string, nodeId?: number): void;
}

export function createDaemonTokenCache(): DaemonTokenCache {
  const entries = new Map<string, Promise<string>>();
  const key = (panelId: string, nodeId: number) => `${panelId}\u0000${nodeId}`;
  return {
    get(panelId, nodeId, fetchToken) {
      const k = key(panelId, nodeId);
      const cached = entries.get(k);
      if (cached) return cached;
      const pending = fetchToken();
      entries.set(k, pending);
      // A failed fetch is not cached, so the next call asks the panel again.
      pending.catch(() => {
        if (entries.get(k) === pending) entries.delete(k);
      });
      return pending;
    },
    has: (panelId, nodeId) => entries.has(key(panelId, nodeId)),
    forget(panelId, nodeId) {
      if (nodeId !== undefined) {
        entries.delete(key(panelId, nodeId));
        return;
      }
      for (const k of [...entries.keys()]) if (k.startsWith(`${panelId}\u0000`)) entries.delete(k);
    },
  };
}

export type DaemonTokenSource = 'manual' | 'panel';

export type ResolvedToken =
  | { token: string; source: DaemonTokenSource }
  /** No token; `panelError` says why the panel did not hand one out. */
  | { token: null; source: null; panelError?: PanelError };

export interface ResolveOptions {
  /** Ask the panel when no token was pasted (needs the application key). */
  fromPanel?: boolean;
  /** Drop the cached panel token first (Wings rejected it). */
  refresh?: boolean;
}

/** The token for a node's Wings API: the pasted one, else the panel's (cached in memory). */
export async function resolveDaemonToken(
  entry: PanelEntry,
  nodeId: number,
  deps: { secrets: SecretStore; admin: ApplicationApi | null; cache: DaemonTokenCache },
  options: ResolveOptions = {}
): Promise<ResolvedToken> {
  if (entry.tokenNodes.includes(nodeId)) {
    const manual = await deps.secrets.get(secretName.daemon(entry.id, nodeId));
    if (manual) return { token: manual, source: 'manual' };
  }
  if (!options.fromPanel || !deps.admin) return { token: null, source: null };
  const admin = deps.admin;
  if (options.refresh) deps.cache.forget(entry.id, nodeId);
  try {
    return { token: await deps.cache.get(entry.id, nodeId, () => admin.daemonToken(nodeId)), source: 'panel' };
  } catch (error) {
    return { token: null, source: null, panelError: error instanceof PanelError ? error : classifyFetchError(error) };
  }
}
