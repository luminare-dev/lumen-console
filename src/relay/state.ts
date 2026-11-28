// The paired relay: its address and what this device chose (AsyncStorage, no secrets), and the
// device token (SecretStore, like the panel keys). One relay per app.

import type { KeyValueStore } from '../state/panels';
import type { SecretStore } from '../state/secrets';
import type { RelayTransport } from './client';

export interface RelayEntry {
  url: string;
  deviceId: string;
  transport: RelayTransport;
  ntfyTopic?: string;
  ntfyUrl?: string;
  /** Panel origins the relay pushes for (at least one event on); the local check skips their notifications. */
  watchedOrigins: string[];
  pairedAt: string;
}

export const RELAY_KEY = 'console.relay.v1';
export const RELAY_TOKEN = 'relay.device';

export async function loadRelay(store: KeyValueStore): Promise<RelayEntry | null> {
  try {
    const raw = await store.getItem(RELAY_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<RelayEntry>;
    if (typeof v.url !== 'string' || typeof v.deviceId !== 'string' || (v.transport !== 'expo' && v.transport !== 'ntfy')) return null;
    return {
      url: v.url,
      deviceId: v.deviceId,
      transport: v.transport,
      ntfyTopic: typeof v.ntfyTopic === 'string' ? v.ntfyTopic : undefined,
      ntfyUrl: typeof v.ntfyUrl === 'string' ? v.ntfyUrl : undefined,
      watchedOrigins: Array.isArray(v.watchedOrigins) ? v.watchedOrigins.filter((o): o is string => typeof o === 'string') : [],
      pairedAt: typeof v.pairedAt === 'string' ? v.pairedAt : '',
    };
  } catch {
    return null;
  }
}

export async function saveRelay(store: KeyValueStore, secrets: SecretStore, entry: RelayEntry, token?: string): Promise<void> {
  if (token) await secrets.set(RELAY_TOKEN, token);
  await store.setItem(RELAY_KEY, JSON.stringify(entry));
}

export async function clearRelay(store: KeyValueStore, secrets: SecretStore): Promise<void> {
  await secrets.remove(RELAY_TOKEN);
  await store.removeItem(RELAY_KEY);
}

/** The origins with at least one subscribed event. */
export function watchedOrigins(panels: { origin: string; events: string[]; enabled: boolean }[]): string[] {
  return [...new Set(panels.filter((p) => p.enabled && p.events.length > 0).map((p) => p.origin.replace(/\/+$/, '')))];
}

/** ntfy's own app link for a topic: ntfy://host/topic subscribes in the ntfy app. */
export function ntfySubscribeLink(ntfyUrl: string, topic: string): string {
  return `ntfy://${ntfyUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${topic}`;
}
