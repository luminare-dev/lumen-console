import { ApplicationApi } from '../api/application';
import { ClientApi } from '../api/client';
import { classifyFetchError, PanelError } from '../api/errors';
import { checkKeyFormat } from '../api/keys';
import { detectFlavor } from '../api/panel';
import { daemonOrigin, normalizePanelUrl } from '../api/url';
import { probeNode } from '../api/wings';
import { MOCK_DAEMON_TOKEN, MOCK_DOWN_NODE_ORIGIN, MOCK_HYDRO_VERSION, MOCK_NODE_ORIGIN } from '../mock/fixtures';
import { createMockPanel, type MockPanel } from '../mock/server';

const NOW = new Date('2026-11-20T10:00:00Z');

function setup(flavor: 'pterodactyl' | 'hydrodactyl' = 'pterodactyl') {
  const mock = createMockPanel({ flavor, now: NOW });
  const client = new ClientApi({ origin: mock.origin, key: mock.clientKey, fetch: mock.fetch });
  const admin = new ApplicationApi({ origin: mock.origin, key: mock.appKey, fetch: mock.fetch });
  return { mock, client, admin };
}

async function rejection(promise: Promise<unknown>): Promise<PanelError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PanelError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const ref = (mock: MockPanel, identifier: string) => ({
  identifier,
  daemon_type: mock.flavor === 'hydrodactyl' ? 'wings' : undefined,
});

describe('addresses and keys', () => {
  it('normalises panel addresses and refuses http', () => {
    expect(normalizePanelUrl('panel.example.net')).toBe('https://panel.example.net');
    expect(normalizePanelUrl('https://Panel.example.net:443/api/client/')).toBe('https://panel.example.net');
    expect(normalizePanelUrl('panel.example.net:8443/auth/login')).toBe('https://panel.example.net:8443');
    expect(() => normalizePanelUrl('http://panel.example.net')).toThrow(expect.objectContaining({ kind: 'insecure' }));
    expect(() => normalizePanelUrl('panel.example.net/somewhere')).toThrow(expect.objectContaining({ kind: 'invalidUrl' }));
    expect(() => normalizePanelUrl(['user:pw', 'panel.example.net'].join('@'))).toThrow(expect.objectContaining({ kind: 'invalidUrl' }));
  });

  it('builds the daemon origin only for https nodes', () => {
    expect(daemonOrigin({ fqdn: 'node1.example.net', scheme: 'https', daemon_listen: 8080 })).toBe(MOCK_NODE_ORIGIN);
    expect(daemonOrigin({ fqdn: 'node1.example.net', scheme: 'https', daemon_listen: 443 })).toBe('https://node1.example.net');
    expect(() => daemonOrigin({ fqdn: 'node1.example.net', scheme: 'http', daemon_listen: 8080 })).toThrow(expect.objectContaining({ kind: 'insecure' }));
  });

  it('refuses a key in the wrong field', () => {
    expect(checkKeyFormat(' ptlc_abc ', 'client')).toBe('ptlc_abc');
    expect(checkKeyFormat('hydro_abc', 'application')).toBe('hydro_abc');
    expect(() => checkKeyFormat('ptla_abc', 'client')).toThrow(expect.objectContaining({ kind: 'wrongKeyType' }));
    expect(() => checkKeyFormat('ptlc_abc', 'application')).toThrow(expect.objectContaining({ kind: 'wrongKeyType' }));
    expect(() => checkKeyFormat('  ', 'client')).toThrow(expect.objectContaining({ kind: 'unauthorized' }));
  });

  it('classifies transport errors', () => {
    expect(classifyFetchError(new Error('SSL handshake failed')).kind).toBe('certificate');
    expect(classifyFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe('timeout');
    expect(classifyFetchError(new TypeError('Network request failed')).kind).toBe('network');
  });
});

describe('Client API', () => {
  it('sends the key as a Bearer token and never with credentials', async () => {
    const mock = createMockPanel({ now: NOW });
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new ClientApi({ origin: mock.origin, key: mock.clientKey, fetch: (url, init) => (calls.push({ url, init }), mock.fetch(url, init)) });
    const account = await client.account();
    expect(account.username).toBe('ada');
    expect(calls[0].url).toBe('https://panel.example.net/api/client/account');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${mock.clientKey}`);
    expect(calls[0].init?.credentials).toBe('omit');
    expect(calls[0].init?.redirect).toBe('error');
  });

  it('lists the servers the account can use, with search and admin-all', async () => {
    const { client, mock } = setup();
    expect((await client.servers()).map((s) => s.name)).toEqual(['Survival', 'Creative', 'Voice relay']);
    expect((await client.servers({ search: 'surv' })).map((s) => s.identifier)).toEqual(['a1b2c3d4']);
    expect((await client.servers({ type: 'admin-all' })).length).toBe(4);
    expect(mock.log).toContain('GET /api/client?filter[*]=surv&per_page=100&page=1');
  });

  it('maps panel errors to kinds and keeps the detail', async () => {
    const { client, mock } = setup();
    const wrong = new ClientApi({ origin: mock.origin, key: 'ptlc_wrong', fetch: mock.fetch });
    expect((await rejection(wrong.account())).kind).toBe('unauthorized');
    const down = await rejection(client.resources('c3d4e5f6'));
    expect(down.kind).toBe('daemon');
    const suspended = await rejection(client.resources('d4e5f6a7'));
    expect(suspended.kind).toBe('conflict');
    expect(suspended.apiMessage).toContain('suspended');
    expect((await rejection(client.server('zzzzzzzz'))).kind).toBe('notFound');
    mock.failNext(429);
    expect((await rejection(client.account())).kind).toBe('rateLimited');
  });

  it('reads resources and sends power signals', async () => {
    const { client, mock } = setup();
    const r = await client.resources('a1b2c3d4');
    expect(r.current_state).toBe('running');
    expect(r.resources.disk_bytes).toBeGreaterThan(18 * 1024 ** 3);
    await client.power(ref(mock, 'a1b2c3d4'), 'stop');
    expect((await client.resources('a1b2c3d4')).current_state).toBe('offline');
    await client.power(ref(mock, 'a1b2c3d4'), 'start');
    expect((await client.resources('a1b2c3d4')).current_state).toBe('running');
  });

  it('browses, edits, renames, creates and deletes files', async () => {
    const { client, mock } = setup();
    const s = ref(mock, 'a1b2c3d4');
    const root = await client.files(s, '/');
    expect(root.find((f) => f.name === 'logs')?.is_file).toBe(false);
    expect(await client.fileContents(s, '/server.properties')).toContain('max-players=20');
    await client.writeFile(s, '/server.properties', 'max-players=30\n');
    expect(await client.fileContents(s, '/server.properties')).toBe('max-players=30\n');
    await client.rename(s, '/', 'eula.txt', 'eula-old.txt');
    expect((await client.files(s, '/')).some((f) => f.name === 'eula-old.txt')).toBe(true);
    await client.createFolder(s, '/', 'backups-local');
    expect(await client.files(s, '/backups-local')).toEqual([]);
    await client.deleteFiles(s, '/', ['eula-old.txt']);
    expect((await client.files(s, '/')).some((f) => f.name === 'eula-old.txt')).toBe(false);
    expect(await client.downloadUrl(s, '/logs/latest.log')).toMatch(/^https:\/\/node1\.example\.net:8080\/download\/file\?token=/);
    const bad = await rejection(client.rename(s, '/', 'server.jar', 'server.properties'));
    expect(bad.kind).toBe('badRequest');
  });

  it('uploads through the signed node URL without the key', async () => {
    const { client, mock } = setup();
    const seen: RequestInit[] = [];
    await client.upload(ref(mock, 'a1b2c3d4'), '/plugins', { name: 'extra.jar', blob: new Blob(['x']) }, (url, init) => {
      seen.push(init ?? {});
      return mock.fetch(url, init);
    });
    expect(mock.uploads).toEqual([{ directory: '/plugins', name: 'extra.jar' }]);
    expect(JSON.stringify(seen[0].headers ?? {})).not.toContain(mock.clientKey);
  });

  it('reads databases, schedules, allocations, startup and subusers', async () => {
    const { client, mock } = setup();
    const s = ref(mock, 'a1b2c3d4');
    expect((await client.databases(s))[0].name).toBe('s1_stats');
    const schedules = await client.schedules(s);
    expect(schedules.map((x) => x.name)).toEqual(['Nightly restart', 'Weekly backup']);
    await client.runSchedule(s, 11);
    expect((await client.allocations(s)).find((a) => a.is_default)?.port).toBe(25565);
    const startup = await client.startup(s);
    expect(startup.variables.map((v) => v.env_variable)).toContain('GAME_VERSION');
    expect(startup.startup_command).toContain('java');
    const updated = await client.setVariable(s, 'GAME_VERSION', '1.21.5');
    expect(updated.server_value).toBe('1.21.5');
    expect((await rejection(client.setVariable(s, 'BUILD_TYPE', 'snapshot'))).apiMessage).toContain('read-only');
    expect((await rejection(client.setVariable(s, 'GAME_VERSION', 'x'.repeat(30)))).kind).toBe('badRequest');
    expect((await client.subusers(s)).map((u) => u.username)).toEqual(['ben']);
    expect((await client.apiKeys()).length).toBe(2);
  });

  it('creates, downloads and restores backups', async () => {
    const { client, mock } = setup();
    const s = ref(mock, 'a1b2c3d4');
    const created = await client.createBackup(s, 'Manual');
    expect(created.name).toBe('Manual');
    expect(created.completed_at).toBeNull();
    const list = await client.backups(s);
    expect(list[0].uuid).toBe(created.uuid);
    expect(await client.backupDownloadUrl(s, list[1].uuid)).toContain('/download/backup');
    const failed = list.find((b) => !b.is_successful && b.completed_at);
    expect((await rejection(client.restoreBackup(s, failed!.uuid, false))).kind).toBe('badRequest');
    await client.restoreBackup(s, 'b0000001-0000-4000-8000-000000000001', false);
    expect(mock.data.servers[0].status).toBe('restoring_backup');
  });
});

describe('Hydrodactyl', () => {
  it('is detected by its version endpoint; Pterodactyl is not', async () => {
    const hydro = setup('hydrodactyl');
    await expect(detectFlavor(hydro.client)).resolves.toEqual({ flavor: 'hydrodactyl', version: MOCK_HYDRO_VERSION });
    const ptero = setup('pterodactyl');
    await expect(detectFlavor(ptero.client)).resolves.toEqual({ flavor: 'pterodactyl' });
  });

  it('routes per-server calls below the daemon type', async () => {
    const { client, mock } = setup('hydrodactyl');
    const [server] = await client.servers();
    expect(server.daemon_type).toBe('wings');
    expect(client.serverPath(server)).toBe('/api/client/servers/wings/a1b2c3d4');
    expect((await client.files(server, '/')).length).toBeGreaterThan(0);
    expect(mock.log).toContain('GET /api/client/servers/wings/a1b2c3d4/files/list?directory=/');
    // The plain path is gone on Hydrodactyl.
    expect((await rejection(client.files({ identifier: 'a1b2c3d4' }, '/'))).kind).toBe('notFound');
    expect((await client.resourceHistory('a1b2c3d4')).length).toBe(12);
  });

  it('reports the panel host status to admins', async () => {
    const { admin } = setup('hydrodactyl');
    const status = await admin.panelStatus();
    expect(status.metrics.cpu_cores).toBe(4);
    expect((await rejection(setup().admin.panelStatus())).kind).toBe('notFound');
  });
});

describe('Application API', () => {
  it('rejects a client key', async () => {
    const { mock } = setup();
    const admin = new ApplicationApi({ origin: mock.origin, key: mock.clientKey, fetch: mock.fetch });
    expect((await rejection(admin.users())).kind).toBe('unauthorized');
  });

  it('lists, searches, creates and edits users', async () => {
    const { admin } = setup();
    expect((await admin.users()).length).toBe(4);
    expect((await admin.users('cle')).map((u) => u.username)).toEqual(['cleo']);
    expect((await admin.users('dario@')).map((u) => u.username)).toEqual(['dario']);
    const created = await admin.createUser({ email: 'eve@example.net', username: 'eve', first_name: 'Eve', last_name: 'Example' });
    expect(created.id).toBe(5);
    const dup = await rejection(admin.createUser({ email: 'eve@example.net', username: 'eve2', first_name: 'E', last_name: 'X' }));
    expect(dup.kind).toBe('badRequest');
    expect(dup.apiMessage).toBe('The email has already been taken.');
    const edited = await admin.updateUser(5, { ...created, first_name: 'Evelyn' });
    expect(edited.first_name).toBe('Evelyn');
  });

  it('suspends, unsuspends and reinstalls servers', async () => {
    const { admin, mock } = setup();
    expect((await admin.servers('voice')).map((s) => s.id)).toEqual([3]);
    await admin.suspend(2);
    expect((await admin.server(2)).suspended).toBe(true);
    await admin.unsuspend(2);
    expect((await admin.server(2)).suspended).toBe(false);
    await admin.reinstall(2);
    expect(mock.data.servers[1].status).toBe('installing');
  });

  it('reads nodes, allocation usage, locations, nests and eggs', async () => {
    const { admin } = setup();
    const nodes = await admin.nodes();
    expect(nodes.map((n) => n.name)).toEqual(['fsn-1', 'hel-2']);
    await expect(admin.allocationUsage(1)).resolves.toEqual({ total: 40, assigned: 9 });
    expect((await admin.locations()).map((l) => l.short)).toEqual(['de-fsn', 'fi-hel']);
    expect((await admin.nests()).length).toBe(2);
    expect((await admin.eggs(1)).map((e) => e.name)).toEqual(['Voxel', 'Voxel modded']);
  });
});

describe('node daemon token', () => {
  it('reads only the token from the node configuration', async () => {
    const { mock, admin } = setup();
    await expect(admin.daemonToken(1)).resolves.toBe(MOCK_DAEMON_TOKEN);
    expect(mock.log).toContain('GET /api/application/nodes/1/configuration');
    expect(mock.log.join('\n')).not.toContain(MOCK_DAEMON_TOKEN);
    const result = await probeNode(MOCK_NODE_ORIGIN, { token: await admin.daemonToken(1), fetch: mock.fetch });
    expect(result.state === 'online' && result.system?.version).toBe('1.11.13');
  });

  it('fails with forbidden when the key may not read nodes, without the token in the error', async () => {
    const { mock, admin } = setup();
    mock.allowNodeConfiguration(false);
    const error = await rejection(admin.daemonToken(1));
    expect(error.kind).toBe('forbidden');
    expect(`${error.message} ${error.apiMessage ?? ''}`).not.toContain(MOCK_DAEMON_TOKEN);
    mock.allowNodeConfiguration(true);
    await expect(rejection(admin.daemonToken(99))).resolves.toMatchObject({ kind: 'notFound' });
  });

  it('refuses a configuration without a token', async () => {
    const fetchImpl = async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ uuid: 'x' }) }) as unknown as Response;
    const admin = new ApplicationApi({ origin: 'https://panel.example.net', key: 'ptla_x', fetch: fetchImpl });
    await expect(rejection(admin.daemonToken(1))).resolves.toMatchObject({ kind: 'invalidResponse' });
  });
});

describe('Wings probe', () => {
  it('sees a running daemon without a token', async () => {
    const { mock } = setup();
    await expect(probeNode(MOCK_NODE_ORIGIN, { fetch: mock.fetch })).resolves.toEqual({ state: 'online' });
  });

  it('reads system information with the daemon token', async () => {
    const { mock } = setup();
    const result = await probeNode(MOCK_NODE_ORIGIN, { token: MOCK_DAEMON_TOKEN, fetch: mock.fetch });
    expect(result.state).toBe('online');
    if (result.state === 'online') expect(result.system?.docker.containers.total).toBe(3);
    await expect(probeNode(MOCK_NODE_ORIGIN, { token: 'wrong', fetch: mock.fetch })).resolves.toEqual({ state: 'tokenRejected' });
  });

  it('reports an unreachable node', async () => {
    const { mock } = setup();
    await expect(probeNode(MOCK_DOWN_NODE_ORIGIN, { fetch: mock.fetch })).resolves.toEqual({ state: 'unreachable', reason: 'network' });
  });
});
