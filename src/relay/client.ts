// The device API of Lumen Console Relay (github.com/luminare-dev/lumen-console-relay, docs/api.md).
// The relay holds the panel keys and pushes alerts; the app only pairs, picks events and
// unregisters. No panel key is ever sent to the relay.

import type { FetchLike } from '../api/http';

export type RelayEvent = 'offline' | 'resources' | 'backups' | 'nodes';
export const RELAY_EVENTS: RelayEvent[] = ['offline', 'resources', 'backups', 'nodes'];
export type RelayTransport = 'expo' | 'ntfy';

export interface RelayInfo {
  name: string;
  version: string;
  transports: RelayTransport[];
  ntfy: { url: string; prefix: string } | null;
  events: RelayEvent[];
  pollSeconds: number;
}

export interface RelayPanel {
  id: string;
  name: string;
  origin: string;
  flavor: string;
  realtime: boolean;
  nodes: boolean;
  events: RelayEvent[];
  lastPollAt: number | null;
  lastError: string | null;
  enabled: boolean;
}

export interface RelayDeviceView {
  device: { id: string; transport: RelayTransport; ntfyTopic?: string; label: string; language: string; disabled: string | null };
  panels: RelayPanel[];
  relay: RelayInfo;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail || code);
  }
}

/** https://host[:port][/path] without a trailing slash; http:// is refused. */
export function normalizeRelayUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (url === '') throw new RelayError(0, 'invalidUrl', 'empty address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  if (!/^https:\/\//i.test(url)) throw new RelayError(0, 'insecure', 'the relay must use https://');
  const rest = url.slice('https://'.length);
  const host = rest.split(/[/?#]/)[0];
  if (host === '' || host.includes('@') || /[?#\s]/.test(rest)) throw new RelayError(0, 'invalidUrl', `not a relay address: ${input}`);
  return `https://${rest}`;
}

export class RelayClient {
  readonly url: string;
  /** The device token from pairing (kept in the SecretStore by the caller). */
  token?: string;
  private readonly fetchImpl: FetchLike;

  constructor(url: string, options: { token?: string; fetch?: FetchLike } = {}) {
    this.url = normalizeRelayUrl(url);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      throw new RelayError(0, 'network', error instanceof Error ? error.message : 'network error');
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const e = (data ?? {}) as { error?: string; detail?: string };
      throw new RelayError(response.status, e.error ?? 'http', e.detail ?? `HTTP ${response.status}`);
    }
    return data as T;
  }

  info(): Promise<RelayInfo> {
    return this.request('GET', '/v1/info');
  }

  /** Pairs this device; the answer carries the device token, shown only once. */
  register(input: { pairing: string; transport: RelayTransport; address?: string; platform: string; language: string; label?: string }) {
    return this.request<RelayDeviceView & { deviceId: string; deviceToken: string }>('POST', '/v1/devices', input);
  }

  device(): Promise<RelayDeviceView> {
    return this.request('GET', '/v1/device');
  }

  update(patch: { subscriptions?: Record<string, RelayEvent[]>; language?: string; address?: string; label?: string }): Promise<RelayDeviceView> {
    return this.request('PUT', '/v1/device', patch);
  }

  unregister(): Promise<void> {
    return this.request('DELETE', '/v1/device');
  }

  test(): Promise<{ sent: boolean }> {
    return this.request('POST', '/v1/device/test', {});
  }
}
