import { PanelError } from '../api/errors';
import { panelAccountUrl } from '../api/url';
import { pickLanguage, translator, formatBytes, formatDuration } from '../i18n';
import { de } from '../i18n/de';
import { en } from '../i18n/en';
import { MOCK_DAEMON_TOKEN, MOCK_HYDRO_VERSION } from '../mock/fixtures';
import { createMockPanel } from '../mock/server';
import { twoFactorView } from '../state/account';
import { addPanel, apisFor, loadPanels, PANELS_KEY, removePanel, setApplicationKey, setDaemonToken, type KeyValueStore } from '../state/panels';
import { createDaemonTokenCache, resolveDaemonToken } from '../state/daemonTokens';
import { createMemorySecretStore } from '../state/secrets';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../state/settings';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
}

async function rejection(promise: Promise<unknown>): Promise<{ kind: string; field?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { kind: string; field?: string };
  }
  throw new Error('expected a rejection');
}

describe('panels', () => {
  it('adds a Pterodactyl panel after checking the key; secrets stay out of the store', async () => {
    const mock = createMockPanel();
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const { entry } = await addPanel({ name: '', url: 'panel.example.net', clientKey: mock.clientKey }, { store, secrets, fetch: mock.fetch });
    expect(entry).toMatchObject({ name: 'panel.example.net', flavor: 'pterodactyl', username: 'ada', rootAdmin: true, hasApplicationKey: false });
    expect(store.data.get(PANELS_KEY)).not.toContain(mock.clientKey);
    const apis = await apisFor(entry, secrets, mock.fetch);
    expect(apis.client).not.toBeNull();
    expect(apis.admin).toBeNull();
  });

  it('detects Hydrodactyl and keeps the application key', async () => {
    const mock = createMockPanel({ flavor: 'hydrodactyl' });
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const { entry } = await addPanel({ name: 'Hydro', url: mock.origin, clientKey: mock.clientKey, applicationKey: mock.appKey }, { store, secrets, fetch: mock.fetch });
    expect(entry).toMatchObject({ flavor: 'hydrodactyl', version: MOCK_HYDRO_VERSION, hasApplicationKey: true });
    expect((await apisFor(entry, secrets, mock.fetch)).admin).not.toBeNull();
  });

  it('says which key failed and saves nothing', async () => {
    const mock = createMockPanel();
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const deps = { store, secrets, fetch: mock.fetch };
    expect(await rejection(addPanel({ name: '', url: mock.origin, clientKey: 'ptlc_wrong' }, deps))).toMatchObject({ kind: 'unauthorized', field: 'client' });
    expect(await rejection(addPanel({ name: '', url: mock.origin, clientKey: mock.appKey }, deps))).toMatchObject({ kind: 'wrongKeyType', field: 'client' });
    expect(await rejection(addPanel({ name: '', url: mock.origin, clientKey: mock.clientKey, applicationKey: 'ptla_wrong' }, deps))).toMatchObject({ kind: 'unauthorized', field: 'application' });
    expect(await rejection(addPanel({ name: '', url: 'http://panel.example.net', clientKey: mock.clientKey }, deps))).toMatchObject({ kind: 'insecure' });
    expect(await loadPanels(store)).toEqual([]);
    expect(mock.log.filter((l) => l.includes('http://'))).toEqual([]);
  });

  it('adds and removes the application key and node tokens, and forgets everything on removal', async () => {
    const mock = createMockPanel();
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const deps = { store, secrets, fetch: mock.fetch };
    const { entry } = await addPanel({ name: 'Main', url: mock.origin, clientKey: mock.clientKey }, deps);
    const [withKey] = await setApplicationKey(entry, mock.appKey, deps);
    expect(withKey.hasApplicationKey).toBe(true);
    const [withToken] = await setDaemonToken(withKey, 1, 'node-secret', deps);
    expect(withToken.tokenNodes).toEqual([1]);
    expect(await secrets.get(`wings.${entry.id}.1`)).toBe('node-secret');
    await removePanel(entry.id, deps);
    expect(await secrets.get(`client.${entry.id}`)).toBeNull();
    expect(await secrets.get(`app.${entry.id}`)).toBeNull();
    expect(await secrets.get(`wings.${entry.id}.1`)).toBeNull();
    expect(await loadPanels(store)).toEqual([]);
  });
});

describe('daemon tokens from the panel', () => {
  const configCalls = (log: string[]) => log.filter((l) => l.endsWith('/configuration')).length;

  async function setupPanel() {
    const mock = createMockPanel();
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const deps = { store, secrets, fetch: mock.fetch };
    const { entry } = await addPanel({ name: 'Main', url: mock.origin, clientKey: mock.clientKey, applicationKey: mock.appKey }, deps);
    const { admin } = await apisFor(entry, secrets, mock.fetch);
    return { mock, store, secrets, deps, entry, admin, cache: createDaemonTokenCache() };
  }

  it('fetches the token once, keeps it in memory only and fetches again after forget or refresh', async () => {
    const { mock, store, secrets, entry, admin, cache } = await setupPanel();
    const deps = { secrets, admin, cache };
    const [a, b] = await Promise.all([resolveDaemonToken(entry, 1, deps, { fromPanel: true }), resolveDaemonToken(entry, 1, deps, { fromPanel: true })]);
    expect(a).toEqual({ token: MOCK_DAEMON_TOKEN, source: 'panel' });
    expect(b).toEqual(a);
    expect(configCalls(mock.log)).toBe(1);
    expect(await secrets.get(`wings.${entry.id}.1`)).toBeNull();
    expect([...store.data.values()].join('\n')).not.toContain(MOCK_DAEMON_TOKEN);
    await resolveDaemonToken(entry, 1, deps, { fromPanel: true, refresh: true });
    expect(configCalls(mock.log)).toBe(2);
    cache.forget(entry.id);
    expect(cache.has(entry.id, 1)).toBe(false);
    await resolveDaemonToken(entry, 1, deps, { fromPanel: true });
    expect(configCalls(mock.log)).toBe(3);
  });

  it('asks the panel only when told to and only with an application key', async () => {
    const { mock, secrets, entry, admin, cache } = await setupPanel();
    await expect(resolveDaemonToken(entry, 1, { secrets, admin, cache })).resolves.toEqual({ token: null, source: null });
    await expect(resolveDaemonToken(entry, 1, { secrets, admin: null, cache }, { fromPanel: true })).resolves.toEqual({ token: null, source: null });
    expect(configCalls(mock.log)).toBe(0);
  });

  it('prefers a pasted token and falls back to it when the key may not read nodes', async () => {
    const { mock, secrets, deps, entry, admin, cache } = await setupPanel();
    mock.allowNodeConfiguration(false);
    const denied = await resolveDaemonToken(entry, 1, { secrets, admin, cache }, { fromPanel: true });
    expect(denied).toMatchObject({ token: null, source: null, panelError: { kind: 'forbidden' } });
    expect(cache.has(entry.id, 1)).toBe(false); // a failure is not cached
    const [withToken] = await setDaemonToken(entry, 1, 'pasted-token', deps);
    await expect(resolveDaemonToken(withToken, 1, { secrets, admin, cache }, { fromPanel: true })).resolves.toEqual({ token: 'pasted-token', source: 'manual' });
    mock.allowNodeConfiguration(true);
    await expect(resolveDaemonToken(withToken, 1, { secrets, admin, cache }, { fromPanel: true })).resolves.toEqual({ token: 'pasted-token', source: 'manual' });
    expect(configCalls(mock.log)).toBe(1);
  });

  it('forgets one panel without touching another', () => {
    const cache = createDaemonTokenCache();
    void cache.get('p1', 1, async () => 'a');
    void cache.get('p1', 2, async () => 'b');
    void cache.get('p10', 1, async () => 'c');
    cache.forget('p1', 2);
    expect(cache.has('p1', 2)).toBe(false);
    expect(cache.has('p1', 1)).toBe(true);
    cache.forget('p1');
    expect(cache.has('p1', 1)).toBe(false);
    expect(cache.has('p10', 1)).toBe(true);
  });
});

describe('account 2FA', () => {
  it('shows 2FA only from the admin API and explains why otherwise', () => {
    expect(twoFactorView({ hasAppKey: false, value: undefined, error: undefined })).toEqual({ state: 'hidden', reason: 'noAppKey' });
    expect(twoFactorView({ hasAppKey: true, value: undefined, error: undefined })).toEqual({ state: 'loading' });
    expect(twoFactorView({ hasAppKey: true, value: true, error: undefined })).toEqual({ state: 'on' });
    expect(twoFactorView({ hasAppKey: true, value: false, error: undefined })).toEqual({ state: 'off' });
    const forbidden = new PanelError('forbidden', 'HTTP 403', { status: 403 });
    expect(twoFactorView({ hasAppKey: true, value: undefined, error: forbidden })).toEqual({ state: 'hidden', reason: 'appKeyCannotRead', error: forbidden });
  });

  it('links to the panel account page and explains it in both languages', () => {
    expect(panelAccountUrl('https://panel.example.net')).toBe('https://panel.example.net/account');
    expect(panelAccountUrl('https://panel.example.net:8443/')).toBe('https://panel.example.net:8443/account');
    expect(translator('en')('account.twoFactorWhyNoKey')).toContain('setup secret');
    expect(translator('de')('account.twoFactorWhyNoKey')).toContain('Einrichtungs-Geheimnis');
  });
});

describe('settings and language', () => {
  it('sanitises stored settings value by value', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ language: 'fr', theme: 'light', thresholds: { diskPercent: 80, memoryPercent: 3, nodePercent: 120 } });
    expect(s.language).toBe('system');
    expect(s.theme).toBe('light');
    expect(s.thresholds).toEqual({ diskPercent: 80, memoryPercent: DEFAULT_SETTINGS.thresholds.memoryPercent, nodePercent: 120 });
  });

  it('has the same keys and placeholders in English and German', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    const names = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort().join(',');
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(`${key}:${names(de[key])}`).toBe(`${key}:${names(en[key])}`);
  });

  it('picks the language and formats values', () => {
    expect(pickLanguage(['de-AT', 'en'])).toBe('de');
    expect(pickLanguage(['fr'])).toBe('en');
    expect(translator('en')('servers.title')).toBe('Servers');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatDuration(3 * 3_600_000 + 25 * 60_000, 'en')).toBe('3 h 25 min');
    expect(formatDuration(0, 'en')).toBe('—');
  });
});
