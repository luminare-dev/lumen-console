// One check of every saved panel: server states and usage over the Client API, the latest backup
// of each server, and (with an application key) the nodes with a Wings probe. The result is kept
// (ids and power states only) for the notification de-duplication and the "stopped" rule.

import type { ApplicationApi } from '../api/application';
import type { ClientApi } from '../api/client';
import { classifyFetchError, PanelError, type ErrorKind } from '../api/errors';
import type { FetchLike } from '../api/http';
import type { PowerState } from '../api/types';
import { daemonOrigin } from '../api/url';
import { probeNode } from '../api/wings';
import { apisFor, loadPanels, type KeyValueStore, type PanelEntry } from '../state/panels';
import { secretName, type SecretStore } from '../state/secrets';
import { evaluatePanel, newAlerts, nodeAllocation, type Alert, type NodeSnapshot, type PanelSnapshot, type ServerSnapshot, type Thresholds } from './evaluate';

/** Upper bounds per panel and check, so a big panel cannot keep the phone busy. */
export const MAX_SERVERS = 40;
export const MAX_BACKUP_SERVERS = 15;

export interface PanelResult {
  panel: Pick<PanelEntry, 'id' | 'name'>;
  alerts: Alert[];
  states: Record<string, PowerState | undefined>;
  error?: ErrorKind;
  noKey?: boolean;
  skipped?: boolean;
}

export interface CheckResult {
  checkedAt: string;
  results: PanelResult[];
}

export const LAST_CHECK_KEY = 'console.lastCheck.v1';

export async function loadLastCheck(store: KeyValueStore): Promise<CheckResult | null> {
  try {
    const raw = await store.getItem(LAST_CHECK_KEY);
    return raw ? (JSON.parse(raw) as CheckResult) : null;
  } catch {
    return null;
  }
}

export interface CheckDeps {
  store: KeyValueStore;
  secrets: SecretStore;
  thresholds: Thresholds;
  fetch?: FetchLike;
  now?: () => Date;
}

async function serverSnapshots(client: ClientApi, withBackups: boolean): Promise<ServerSnapshot[]> {
  const servers = (await client.servers()).slice(0, MAX_SERVERS);
  const out: ServerSnapshot[] = [];
  for (const [index, server] of servers.entries()) {
    const snap: ServerSnapshot = {
      identifier: server.identifier,
      name: server.name,
      node: server.node,
      status: server.status ?? null,
      diskLimitMiB: server.limits.disk,
      memoryLimitMiB: server.limits.memory,
    };
    if (snap.status === null) {
      try {
        const r = await client.resources(server.identifier);
        snap.state = r.current_state;
        snap.diskBytes = r.resources.disk_bytes;
        snap.memoryBytes = r.resources.memory_bytes;
      } catch (error) {
        snap.error = (error instanceof PanelError ? error : classifyFetchError(error)).kind;
      }
      if (withBackups && index < MAX_BACKUP_SERVERS && !snap.error && server.feature_limits.backups > 0) {
        try {
          const backups = await client.backups(server);
          const done = backups.filter((b) => b.completed_at).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
          const latest = done[0];
          if (latest) snap.latestBackup = { uuid: latest.uuid, name: latest.name, failed: !latest.is_successful };
        } catch {
          // no permission for backups on this server: skipped
        }
      }
    }
    out.push(snap);
  }
  return out;
}

async function nodeSnapshots(admin: ApplicationApi, entry: PanelEntry, secrets: SecretStore, fetchImpl?: FetchLike): Promise<NodeSnapshot[]> {
  const nodes = await admin.nodes();
  const out: NodeSnapshot[] = [];
  for (const node of nodes) {
    let reachable: boolean | undefined;
    try {
      const token = entry.tokenNodes.includes(node.id) ? await secrets.get(secretName.daemon(entry.id, node.id)) : null;
      const probe = await probeNode(daemonOrigin(node), { token: token ?? undefined, fetch: fetchImpl });
      reachable = probe.state !== 'unreachable';
    } catch {
      reachable = undefined; // an http node is not probed
    }
    out.push({ id: node.id, name: node.name, maintenance: node.maintenance_mode, reachable, ...nodeAllocation(node) });
  }
  return out;
}

/** Runs one check; returns the result and the alerts that are new since the previous check. */
export async function checkAllPanels(deps: CheckDeps): Promise<{ result: CheckResult; fresh: { panel: string; alert: Alert }[] }> {
  const now = deps.now ?? (() => new Date());
  const previous = await loadLastCheck(deps.store);
  const panels = await loadPanels(deps.store);
  const results: PanelResult[] = [];
  const fresh: { panel: string; alert: Alert }[] = [];

  for (const entry of panels) {
    const base = { panel: { id: entry.id, name: entry.name } };
    const before = previous?.results.find((r) => r.panel.id === entry.id);
    if (!entry.alerts.enabled) {
      results.push({ ...base, alerts: [], states: {}, skipped: true });
      continue;
    }
    const { client, admin } = await apisFor(entry, deps.secrets, deps.fetch);
    if (!client) {
      results.push({ ...base, alerts: [], states: before?.states ?? {}, noKey: true });
      continue;
    }
    try {
      const snapshot: PanelSnapshot = { servers: await serverSnapshots(client, entry.alerts.backups) };
      if (admin && entry.alerts.nodes) {
        try {
          snapshot.nodes = await nodeSnapshots(admin, entry, deps.secrets, deps.fetch);
        } catch {
          // a key without node permission: the server checks still count
        }
      }
      const alerts = evaluatePanel(snapshot, before?.states ?? {}, entry.alerts, deps.thresholds);
      const states: Record<string, PowerState | undefined> = {};
      for (const s of snapshot.servers) states[s.identifier] = s.state ?? before?.states[s.identifier];
      results.push({ ...base, alerts, states });
      for (const alert of newAlerts(before?.alerts.map((a) => a.id) ?? [], alerts)) fresh.push({ panel: entry.name, alert });
    } catch (error) {
      const kind = (error instanceof PanelError ? error : classifyFetchError(error)).kind;
      results.push({ ...base, alerts: [], states: before?.states ?? {}, error: kind });
    }
  }

  const result: CheckResult = { checkedAt: now().toISOString(), results };
  await deps.store.setItem(LAST_CHECK_KEY, JSON.stringify(result));
  return { result, fresh };
}
