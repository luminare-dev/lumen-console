// Turns a snapshot of one panel into alerts. Pure functions: the background task, the alerts
// screen and the tests all use the same rules.

import type { ErrorKind } from '../api/errors';
import type { PowerState, ServerStatus } from '../api/types';
import type { PanelAlertSettings } from '../state/panels';

export interface Thresholds {
  /** Warn when a server's disk is this full (servers with a disk limit only). */
  diskPercent: number;
  /** Warn when a running server uses this much of its memory limit. */
  memoryPercent: number;
  /** Warn when a node has this much of its memory or disk allocated to servers. */
  nodePercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { diskPercent: 90, memoryPercent: 95, nodePercent: 95 };

export type AlertKind = 'serverStopped' | 'serverUnreachable' | 'disk' | 'memory' | 'backup' | 'nodeDown' | 'nodeAllocated';

export interface Alert {
  /** Stable across checks, so a notification is sent once per problem, not on every check. */
  id: string;
  kind: AlertKind;
  severity: 'warning' | 'critical';
  /** Values for the message: server, node, percent, backup, what. */
  params: Record<string, string | number>;
}

export interface ServerSnapshot {
  identifier: string;
  name: string;
  node: string;
  status: ServerStatus;
  state?: PowerState;
  /** Set when /resources failed. */
  error?: ErrorKind;
  /** Bytes used and limit in MiB (0 = unlimited). */
  diskBytes?: number;
  diskLimitMiB?: number;
  memoryBytes?: number;
  memoryLimitMiB?: number;
  latestBackup?: { uuid: string; name: string; failed: boolean };
}

export interface NodeSnapshot {
  id: number;
  name: string;
  maintenance: boolean;
  /** undefined: not probed. */
  reachable?: boolean;
  memoryPercent: number;
  diskPercent: number;
}

export interface PanelSnapshot {
  servers: ServerSnapshot[];
  nodes?: NodeSnapshot[];
}

const MiB = 1024 * 1024;

/**
 * Evaluates one panel. `previousStates` are the power states of the previous check: a server
 * that was running then and is offline now (and not suspended or installing) has stopped or
 * crashed. The panel does not say which of the two; the console shows Wings' crash message.
 */
export function evaluatePanel(
  snapshot: PanelSnapshot,
  previousStates: Record<string, PowerState | undefined>,
  settings: PanelAlertSettings,
  thresholds: Thresholds
): Alert[] {
  const alerts: Alert[] = [];
  const downNodes = new Set((snapshot.nodes ?? []).filter((n) => n.reachable === false && !n.maintenance).map((n) => n.name));

  for (const s of snapshot.servers) {
    if (s.status !== null) continue; // suspended, installing, restoring: nothing to watch
    if (s.error === 'daemon') {
      // Covered by the node alert when the node itself is known to be down.
      if (settings.offline && !downNodes.has(s.node)) {
        alerts.push({ id: `unreachable:${s.identifier}`, kind: 'serverUnreachable', severity: 'critical', params: { server: s.name, node: s.node } });
      }
      continue;
    }
    if (settings.offline && s.state === 'offline') {
      const before = previousStates[s.identifier];
      if (before === 'running' || before === 'starting') {
        alerts.push({ id: `stopped:${s.identifier}`, kind: 'serverStopped', severity: 'critical', params: { server: s.name } });
      }
    }
    if (settings.resources) {
      if (s.diskLimitMiB && s.diskBytes !== undefined) {
        const percent = (s.diskBytes / (s.diskLimitMiB * MiB)) * 100;
        if (percent >= thresholds.diskPercent) {
          alerts.push({ id: `disk:${s.identifier}`, kind: 'disk', severity: percent >= 100 ? 'critical' : 'warning', params: { server: s.name, percent: Math.round(percent) } });
        }
      }
      if (s.state === 'running' && s.memoryLimitMiB && s.memoryBytes !== undefined) {
        const percent = (s.memoryBytes / (s.memoryLimitMiB * MiB)) * 100;
        if (percent >= thresholds.memoryPercent) {
          alerts.push({ id: `memory:${s.identifier}`, kind: 'memory', severity: 'warning', params: { server: s.name, percent: Math.round(percent) } });
        }
      }
    }
    if (settings.backups && s.latestBackup?.failed) {
      alerts.push({ id: `backup:${s.identifier}:${s.latestBackup.uuid}`, kind: 'backup', severity: 'warning', params: { server: s.name, backup: s.latestBackup.name } });
    }
  }

  if (settings.nodes) {
    for (const n of snapshot.nodes ?? []) {
      if (n.maintenance) continue;
      if (n.reachable === false) alerts.push({ id: `node:${n.id}`, kind: 'nodeDown', severity: 'critical', params: { node: n.name } });
      const worst = Math.max(n.memoryPercent, n.diskPercent);
      if (worst >= thresholds.nodePercent) {
        const what = n.diskPercent >= n.memoryPercent ? 'disk' : 'memory';
        alerts.push({ id: `node-alloc:${n.id}:${what}`, kind: 'nodeAllocated', severity: 'warning', params: { node: n.name, percent: Math.round(worst), what } });
      }
    }
  }

  const order = { critical: 0, warning: 1 };
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** The alerts of `current` that were not in the previous check (by id), for notifications. */
export function newAlerts(previousIds: readonly string[], current: readonly Alert[]): Alert[] {
  const seen = new Set(previousIds);
  return current.filter((alert) => !seen.has(alert.id));
}

/** Allocation of a node in percent of its capacity (overallocation counts against 100 %). */
export function nodeAllocation(node: { memory: number; disk: number; allocated_resources: { memory: number; disk: number } }): { memoryPercent: number; diskPercent: number } {
  const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
  return { memoryPercent: pct(node.allocated_resources.memory, node.memory), diskPercent: pct(node.allocated_resources.disk, node.disk) };
}
