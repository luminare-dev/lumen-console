import { checkAllPanels, loadLastCheck } from '../alerts/check';
import { DEFAULT_THRESHOLDS, evaluatePanel, newAlerts, nodeAllocation, type PanelSnapshot } from '../alerts/evaluate';
import { alertMessage } from '../alerts/messages';
import { translator } from '../i18n';
import { MOCK_DAEMON_TOKEN } from '../mock/fixtures';
import { createMockPanel } from '../mock/server';
import { addPanel, DEFAULT_PANEL_ALERTS, setDaemonToken, updatePanel, type KeyValueStore } from '../state/panels';
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

const MiB = 1024 * 1024;

describe('evaluatePanel', () => {
  const base: PanelSnapshot = {
    servers: [
      { identifier: 'a', name: 'Alpha', node: 'n1', status: null, state: 'offline', diskBytes: 950 * MiB, diskLimitMiB: 1000, memoryBytes: 0, memoryLimitMiB: 1024 },
      { identifier: 'b', name: 'Beta', node: 'n1', status: null, state: 'running', diskBytes: 10 * MiB, diskLimitMiB: 0, memoryBytes: 1000 * MiB, memoryLimitMiB: 1024, latestBackup: { uuid: 'u1', name: 'Nightly', failed: true } },
      { identifier: 'c', name: 'Gamma', node: 'n2', status: null, error: 'daemon' },
      { identifier: 'd', name: 'Delta', node: 'n1', status: 'suspended', state: 'offline' },
    ],
    nodes: [
      { id: 1, name: 'n1', maintenance: false, reachable: true, memoryPercent: 40, diskPercent: 97 },
      { id: 2, name: 'n2', maintenance: false, reachable: false, memoryPercent: 10, diskPercent: 10 },
      { id: 3, name: 'n3', maintenance: true, reachable: false, memoryPercent: 99, diskPercent: 99 },
    ],
  };

  it('finds stopped servers, full disks, memory, failed backups and node problems', () => {
    const alerts = evaluatePanel(base, { a: 'running', b: 'running' }, DEFAULT_PANEL_ALERTS, DEFAULT_THRESHOLDS);
    const ids = alerts.map((a) => a.id);
    expect(ids).toContain('stopped:a');
    expect(ids).toContain('disk:a');
    expect(ids).toContain('memory:b');
    expect(ids).toContain('backup:b:u1');
    expect(ids).toContain('node:2');
    expect(ids).toContain('node-alloc:1:disk');
    // Gamma's node is known to be down: the node alert covers it.
    expect(ids).not.toContain('unreachable:c');
    // Suspended servers and nodes in maintenance are not watched.
    expect(ids.filter((id) => /:d$|^node:3|^node-alloc:3/.test(id))).toEqual([]);
    expect(alerts[0].severity).toBe('critical');
  });

  it('needs a previous running state for the stopped alert', () => {
    const alerts = evaluatePanel(base, {}, DEFAULT_PANEL_ALERTS, DEFAULT_THRESHOLDS);
    expect(alerts.map((a) => a.kind)).not.toContain('serverStopped');
  });

  it('follows the per-panel switches', () => {
    const off = { ...DEFAULT_PANEL_ALERTS, offline: false, resources: false, backups: false, nodes: false };
    expect(evaluatePanel(base, { a: 'running' }, off, DEFAULT_THRESHOLDS)).toEqual([]);
    const noNodes = evaluatePanel({ servers: base.servers }, {}, DEFAULT_PANEL_ALERTS, DEFAULT_THRESHOLDS);
    expect(noNodes.map((a) => a.id)).toContain('unreachable:c');
  });

  it('reports only new alerts', () => {
    const alerts = evaluatePanel(base, {}, DEFAULT_PANEL_ALERTS, DEFAULT_THRESHOLDS);
    expect(newAlerts(alerts.map((a) => a.id), alerts)).toEqual([]);
    expect(newAlerts([], alerts)).toHaveLength(alerts.length);
  });

  it('computes node allocation', () => {
    expect(nodeAllocation({ memory: 1000, disk: 0, allocated_resources: { memory: 250, disk: 5 } })).toEqual({ memoryPercent: 25, diskPercent: 0 });
  });

  it('writes the messages in both languages', () => {
    const [alert] = evaluatePanel({ servers: [base.servers[0]] }, { a: 'running' }, DEFAULT_PANEL_ALERTS, DEFAULT_THRESHOLDS);
    expect(alertMessage(alert, 'Main', translator('en'))).toBe('Main: Alpha stopped or crashed.');
    expect(alertMessage(alert, 'Main', translator('de'))).toBe('Main: Alpha wurde gestoppt oder ist abgestürzt.');
  });
});

describe('checkAllPanels', () => {
  it('checks the mock panel and notifies only once per problem', async () => {
    const mock = createMockPanel();
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const { entry } = await addPanel({ name: 'Main', url: mock.origin, clientKey: mock.clientKey, applicationKey: mock.appKey }, { store, secrets, fetch: mock.fetch });
    const deps = { store, secrets, thresholds: DEFAULT_THRESHOLDS, fetch: mock.fetch };

    const first = await checkAllPanels(deps);
    const kinds = first.result.results[0].alerts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['disk', 'backup', 'nodeDown', 'nodeAllocated']));
    expect(first.fresh.length).toBe(first.result.results[0].alerts.length);

    // The running server stops between two checks.
    mock.data.servers[0].state = 'offline';
    const second = await checkAllPanels(deps);
    expect(second.fresh.map((f) => f.alert.kind)).toEqual(['serverStopped']);
    expect((await loadLastCheck(store))?.results[0].states.a1b2c3d4).toBe('offline');

    // With a daemon token the probe reads Wings' system information.
    await setDaemonToken(entry, 1, MOCK_DAEMON_TOKEN, { store, secrets });
    await checkAllPanels(deps);
    expect(mock.log).toContain('node1 GET /api/system');

    // A switched-off panel is skipped.
    await updatePanel(entry.id, { alerts: { ...entry.alerts, enabled: false } }, store);
    const skipped = await checkAllPanels(deps);
    expect(skipped.result.results[0].skipped).toBe(true);
  });

  it('reports a panel whose key is gone', async () => {
    const mock = createMockPanel();
    const store = memoryStore();
    const secrets = createMemorySecretStore();
    const { entry } = await addPanel({ name: 'Main', url: mock.origin, clientKey: mock.clientKey }, { store, secrets, fetch: mock.fetch });
    await secrets.remove(`client.${entry.id}`);
    const { result } = await checkAllPanels({ store, secrets, thresholds: DEFAULT_THRESHOLDS, fetch: mock.fetch });
    expect(result.results[0].noKey).toBe(true);
  });
});
