import { normalizeRelayUrl, RelayClient, RelayError } from '../relay/client';
import { parseLink, routeForLink } from '../relay/links';
import { clearRelay, loadRelay, ntfySubscribeLink, RELAY_TOKEN, saveRelay, watchedOrigins } from '../relay/state';
import type { KeyValueStore } from '../state/panels';
import { createMemorySecretStore } from '../state/secrets';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => (body === null ? '' : JSON.stringify(body)) } as Response;
}

describe('relay address', () => {
  it('adds https, keeps a path and refuses http', () => {
    expect(normalizeRelayUrl('relay.example.org/')).toBe('https://relay.example.org');
    expect(normalizeRelayUrl('https://example.org/relay/')).toBe('https://example.org/relay');
    expect(() => normalizeRelayUrl('http://relay.example.org')).toThrow(RelayError);
    expect(() => normalizeRelayUrl(`https://u${'@'}relay.example.org`)).toThrow(RelayError);
    expect(() => normalizeRelayUrl('')).toThrow(RelayError);
  });
});

describe('relay client', () => {
  it('registers without panel keys and sends the device token afterwards', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/devices')) return jsonResponse(201, { deviceId: 'd1', deviceToken: 'tok', device: { ntfyTopic: 'lumenrelay_x' }, panels: [], relay: {} });
      if (url.endsWith('/v1/device') && init?.method === 'DELETE') return jsonResponse(204, null);
      return jsonResponse(403, { error: 'pairing', detail: 'wrong code' });
    };
    const client = new RelayClient('relay.example.org', { fetch: fetchImpl });
    const result = await client.register({ pairing: 'K7QM-XW3D-PA9T', transport: 'ntfy', platform: 'android', language: 'en' });
    expect(result.deviceToken).toBe('tok');
    expect(calls[0].url).toBe('https://relay.example.org/v1/devices');
    expect(calls[0].init?.redirect).toBe('error');
    expect(String(calls[0].init?.body)).not.toMatch(/ptlc_|ptla_|key/i);
    client.token = 'tok';
    await client.unregister();
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    await expect(new RelayClient('relay.example.org', { fetch: fetchImpl }).test()).rejects.toMatchObject({ code: 'pairing', status: 403 });
  });

  it('reports network errors', async () => {
    const client = new RelayClient('relay.example.org', { fetch: async () => Promise.reject(new Error('offline')) });
    await expect(client.info()).rejects.toMatchObject({ code: 'network' });
  });
});

describe('links', () => {
  const panels = [{ id: 'p1', origin: 'https://panel.example.org' }];

  it('parses pairing and alert links', () => {
    expect(parseLink('lumenconsole://relay?url=https%3A%2F%2Frelay.example.org&code=K7QM-XW3D-PA9T')).toEqual({
      kind: 'relay',
      url: 'https://relay.example.org',
      code: 'K7QM-XW3D-PA9T',
    });
    expect(parseLink('lumenconsole://alert?origin=https%3A%2F%2Fpanel.example.org&server=a1b2c3d4')).toEqual({
      kind: 'alert',
      origin: 'https://panel.example.org',
      server: 'a1b2c3d4',
      node: undefined,
    });
    expect(parseLink('lumenconsole://alert?origin=http%3A%2F%2Fpanel.example.org')).toBeNull();
    expect(parseLink('lumenconsole://alert?origin=https%3A%2F%2Fp.example.org&server=..%2Fx')).toMatchObject({ server: undefined });
    expect(parseLink('https://example.org')).toBeNull();
    expect(parseLink(null)).toBeNull();
  });

  it('routes to the server, the node or the relay screen', () => {
    expect(routeForLink({ kind: 'alert', origin: 'https://panel.example.org', server: 'a1' }, panels)).toEqual({ tab: 'servers', route: { name: 'server', id: 'a1' }, panelId: 'p1' });
    expect(routeForLink({ kind: 'alert', origin: 'https://panel.example.org', node: 3 }, panels)).toEqual({ tab: 'admin', route: { name: 'adminNode', id: 3 }, panelId: 'p1' });
    expect(routeForLink({ kind: 'alert', origin: 'https://other.example.org', server: 'a1' }, panels)).toBeNull();
    expect(routeForLink({ kind: 'relay', url: 'https://r.example.org', code: 'X' }, panels)).toEqual({ tab: 'settings', route: { name: 'relay', url: 'https://r.example.org', code: 'X' } });
  });
});

describe('relay state', () => {
  it('keeps the token in the secret store and the rest in the key-value store', async () => {
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const entry = { url: 'https://relay.example.org', deviceId: 'd1', transport: 'ntfy' as const, ntfyTopic: 'lumenrelay_x', watchedOrigins: ['https://panel.example.org'], pairedAt: '2026-11-28T00:00:00Z' };
    await saveRelay(store, secrets, entry, 'device-token');
    expect([...store.data.values()].join()).not.toContain('device-token');
    expect(await secrets.get(RELAY_TOKEN)).toBe('device-token');
    expect(await loadRelay(store)).toEqual({ ...entry, ntfyUrl: undefined });
    await clearRelay(store, secrets);
    expect(await loadRelay(store)).toBeNull();
    expect(await secrets.get(RELAY_TOKEN)).toBeNull();
  });

  it('lists the origins the relay pushes for and the ntfy subscribe link', () => {
    expect(
      watchedOrigins([
        { origin: 'https://a.example.org', events: ['offline'], enabled: true },
        { origin: 'https://b.example.org', events: [], enabled: true },
        { origin: 'https://c.example.org', events: ['nodes'], enabled: false },
      ])
    ).toEqual(['https://a.example.org']);
    expect(ntfySubscribeLink('https://ntfy.example.org/', 'lumenrelay_x')).toBe('ntfy://ntfy.example.org/lumenrelay_x');
  });
});
