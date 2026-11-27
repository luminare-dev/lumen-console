import { useCallback, useEffect, useState } from 'react';

import { classifyFetchError, PanelError } from '../api/errors';
import type { PanelNode } from '../api/types';
import { daemonOrigin } from '../api/url';
import { probeNode, type ProbeResult } from '../api/wings';
import { nodeAllocation } from '../alerts/evaluate';
import { formatBytes, formatMiB } from '../i18n';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import type { DaemonTokenSource } from '../state/daemonTokens';
import { useResource } from '../state/useResource';
import { Badge, Button, Card, Disclosure, ErrorPanel, Field, KeyValue, ListRow, Loading, Meter, Notice, Screen, Section, T, type Tone } from '../ui/kit';
import { NeedsAppKey } from './admin';

const asPanelError = (error: unknown) => (error instanceof PanelError ? error : classifyFetchError(error));

interface Probe {
  result: ProbeResult | undefined;
  /** Where the token came from: pasted, read from the panel, or none. */
  source: DaemonTokenSource | null;
  /** Why the panel did not hand out the token (only with fromPanel). */
  panelError: PanelError | undefined;
  reprobe: () => void;
}

/**
 * Probes a node's Wings with the pasted token or, with fromPanel, the one the panel hands out
 * (kept in memory only). A panel token Wings rejects is fetched once more, in case it changed.
 */
function useProbe(node: PanelNode | undefined, fromPanel: boolean): Probe {
  const { daemonToken } = useApp();
  const [state, setState] = useState<Omit<Probe, 'reprobe'>>({ result: undefined, source: null, panelError: undefined });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!node) return undefined;
    let cancelled = false;
    setState({ result: undefined, source: null, panelError: undefined });
    void (async () => {
      let origin: string;
      try {
        origin = daemonOrigin(node);
      } catch (error) {
        if (!cancelled) setState({ result: { state: 'unreachable', reason: asPanelError(error).kind }, source: null, panelError: undefined });
        return;
      }
      let resolved = await daemonToken(node.id, { fromPanel });
      let result = await probeNode(origin, { token: resolved.token ?? undefined });
      if (result.state === 'tokenRejected' && resolved.source === 'panel' && !cancelled) {
        resolved = await daemonToken(node.id, { fromPanel, refresh: true });
        if (resolved.token) result = await probeNode(origin, { token: resolved.token });
      }
      if (!cancelled) setState({ result, source: resolved.source, panelError: resolved.token === null ? resolved.panelError : undefined });
    })();
    return () => {
      cancelled = true;
    };
  }, [node, daemonToken, fromPanel, round]);
  const reprobe = useCallback(() => setRound((n) => n + 1), []);
  return { ...state, reprobe };
}

function probeBadge(t: ReturnType<typeof useApp>['t'], result: ProbeResult | undefined, maintenance: boolean): { label: string; tone: Tone } {
  if (maintenance) return { label: t('nodes.maintenance'), tone: 'warning' };
  if (!result) return { label: t('nodes.checking'), tone: 'neutral' };
  if (result.state === 'online') return { label: t('nodes.online'), tone: 'success' };
  if (result.state === 'tokenRejected') return { label: t('nodes.tokenRejected'), tone: 'warning' };
  return { label: t('nodes.unreachable'), tone: 'danger' };
}

function NodeRow({ node }: { node: PanelNode }) {
  const { t } = useApp();
  const nav = useNav();
  // The list only needs reachability: no panel token is fetched for it.
  const { result } = useProbe(node, false);
  const badge = probeBadge(t, result, node.maintenance_mode);
  const alloc = nodeAllocation(node);
  return (
    <ListRow
      title={node.name}
      subtitle={`${node.fqdn} · ${t('nodes.allocatedShort', { memory: Math.round(alloc.memoryPercent), disk: Math.round(alloc.diskPercent) })}`}
      right={<Badge label={badge.label} tone={badge.tone} testID={`node-state-${node.id}`} />}
      onPress={() => nav.push({ name: 'adminNode', id: node.id })}
      testID={`row-node-${node.id}`}
    />
  );
}

export function AdminNodesScreen() {
  const { t, admin } = useApp();
  const nav = useNav();
  const nodes = useResource(admin, 'nodes', (a) => a.nodes());
  return (
    <Screen title={t('admin.nodes')} onBack={nav.pop} testID="screen-admin-nodes">
      {!admin ? <NeedsAppKey /> : null}
      {nodes.error ? <ErrorPanel error={nodes.error} onRetry={nodes.reload} /> : null}
      {nodes.loading && !nodes.data ? <Loading /> : null}
      {(nodes.data ?? []).map((node) => (
        <NodeRow key={node.id} node={node} />
      ))}
      <T variant="caption">{t('nodes.probeNote')}</T>
    </Screen>
  );
}

export function AdminNodeScreen({ id }: { id: number }) {
  const { t, admin, language, active, setDaemonToken } = useApp();
  const nav = useNav();
  const node = useResource(admin, `node:${id}`, (a) => a.node(id));
  const usage = useResource(admin, `allocations:${id}`, (a) => a.allocationUsage(id));
  const locations = useResource(admin, 'locations', (a) => a.locations());
  const n = node.data;
  const { result, source, panelError, reprobe } = useProbe(n, true);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const hasToken = (active?.tokenNodes.includes(id) ?? false) || source === 'manual';
  const badge = probeBadge(t, result, n?.maintenance_mode ?? false);

  const saveToken = async (value: string | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await setDaemonToken(id, value);
      setToken('');
      reprobe();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
    }
  };

  const tokenForm = (
    <>
      <Field label={t('nodes.token')} value={token} onChangeText={setToken} secure hint={t('nodes.tokenHint')} testID="node-token" />
      {error ? <ErrorPanel error={error} /> : null}
      <Button label={t('nodes.tokenSave')} onPress={() => void saveToken(token)} busy={busy} disabled={token.trim() === ''} testID="token-save" />
    </>
  );

  const alloc = n ? nodeAllocation(n) : undefined;
  const system = result?.state === 'online' ? result.system : undefined;

  return (
    <Screen title={n?.name ?? String(id)} onBack={nav.pop} testID="screen-admin-node">
      {node.error ? <ErrorPanel error={node.error} onRetry={node.reload} /> : null}
      {!n && !node.error ? <Loading /> : null}
      {n && alloc ? (
        <>
          <Card>
            <Badge label={badge.label} tone={badge.tone} testID="node-state" />
            <KeyValue label={t('nodes.address')} value={`${n.fqdn}:${n.daemon_listen}`} />
            <KeyValue label={t('nodes.location')} value={locations.data?.find((l) => l.id === n.location_id)?.short ?? String(n.location_id)} />
            {n.daemon_type ? <KeyValue label={t('nodes.daemon')} value={n.daemon_type} /> : null}
            <Meter label={t('nodes.memoryAllocated')} percent={alloc.memoryPercent} detail={`${formatMiB(n.allocated_resources.memory, language, '0')} / ${formatMiB(n.memory, language, t('common.unlimited'))}${n.memory_overallocate ? ` (+${n.memory_overallocate} %)` : ''}`} testID="node-memory" />
            <Meter label={t('nodes.diskAllocated')} percent={alloc.diskPercent} detail={`${formatMiB(n.allocated_resources.disk, language, '0')} / ${formatMiB(n.disk, language, t('common.unlimited'))}${n.disk_overallocate ? ` (+${n.disk_overallocate} %)` : ''}`} testID="node-disk" />
            {usage.data ? (
              <Meter label={t('nodes.allocations')} percent={usage.data.total ? (usage.data.assigned / usage.data.total) * 100 : 0} detail={t('nodes.allocationsDetail', { used: usage.data.assigned, total: usage.data.total })} testID="node-allocations" />
            ) : null}
            {usage.error ? <ErrorPanel error={usage.error} /> : null}
          </Card>

          <Section title={t('nodes.wings')}>
            <Card testID="node-wings">
              {system ? (
                <>
                  <KeyValue label={t('nodes.wingsVersion')} value={system.version} />
                  <KeyValue label={t('nodes.containers')} value={t('nodes.containersDetail', { running: system.docker.containers.running, total: system.docker.containers.total })} />
                  <KeyValue label={t('nodes.system')} value={`${system.system.os} · ${system.system.cpu_threads} × CPU · ${formatBytes(system.system.memory_bytes, language)}`} />
                  <KeyValue label={t('nodes.kernel')} value={system.system.kernel_version} />
                  <KeyValue label="Docker" value={system.docker.version} />
                </>
              ) : (
                <T variant="muted">
                  {!result
                    ? t('nodes.checking')
                    : result.state === 'unreachable'
                      ? t('nodes.unreachableDetail', { reason: t(`error.${result.reason}`) })
                      : result.state === 'tokenRejected'
                        ? t('nodes.tokenRejectedDetail')
                        : t('nodes.noToken')}
                </T>
              )}
              {source === 'panel' ? <T variant="caption" testID="node-token-source">{t('nodes.tokenFromPanel')}</T> : null}
              {source === 'manual' ? <T variant="caption" testID="node-token-source">{t('nodes.tokenManual')}</T> : null}
              {panelError ? (
                <Notice tone="warning" testID="node-token-panel-error">
                  {panelError.kind === 'forbidden' ? t('nodes.tokenPanelForbidden') : t('nodes.tokenPanelFailed', { reason: t(`error.${panelError.kind}`) })}
                </Notice>
              ) : null}
              {hasToken ? (
                <Button label={t('nodes.tokenRemove')} kind="ghost" compact onPress={() => void saveToken(null)} busy={busy} testID="token-remove" />
              ) : source === 'panel' ? (
                <Disclosure label={t('nodes.tokenOverride')} testID="token-override">
                  {tokenForm}
                </Disclosure>
              ) : (
                tokenForm
              )}
            </Card>
          </Section>
          {n.scheme !== 'https' ? <Notice tone="warning">{t('nodes.httpNode')}</Notice> : null}
        </>
      ) : null}
    </Screen>
  );
}

export function AdminLocationsScreen() {
  const { t, admin } = useApp();
  const nav = useNav();
  const locations = useResource(admin, 'locations', (a) => a.locations());
  const nodes = useResource(admin, 'nodes', (a) => a.nodes());
  return (
    <Screen title={t('admin.locations')} onBack={nav.pop} testID="screen-admin-locations">
      {!admin ? <NeedsAppKey /> : null}
      {locations.error ? <ErrorPanel error={locations.error} onRetry={locations.reload} /> : null}
      {locations.loading && !locations.data ? <Loading /> : null}
      {(locations.data ?? []).map((l) => (
        <ListRow
          key={l.id}
          title={l.short}
          subtitle={[l.long, t('locations.nodes', { count: (nodes.data ?? []).filter((n) => n.location_id === l.id).length })].filter(Boolean).join(' · ')}
          testID={`location-${l.id}`}
        />
      ))}
    </Screen>
  );
}

export function AdminNestsScreen() {
  const { t, admin } = useApp();
  const nav = useNav();
  const nests = useResource(admin, 'nests', (a) => a.nests());
  return (
    <Screen title={t('admin.nests')} onBack={nav.pop} testID="screen-admin-nests">
      {!admin ? <NeedsAppKey /> : null}
      {nests.error ? <ErrorPanel error={nests.error} onRetry={nests.reload} /> : null}
      {nests.loading && !nests.data ? <Loading /> : null}
      {(nests.data ?? []).map((nest) => (
        <ListRow key={nest.id} title={nest.name} subtitle={nest.description ?? undefined} onPress={() => nav.push({ name: 'adminNest', id: nest.id })} testID={`nest-${nest.id}`} />
      ))}
    </Screen>
  );
}

export function AdminNestScreen({ id }: { id: number }) {
  const { t, admin } = useApp();
  const nav = useNav();
  const nests = useResource(admin, 'nests', (a) => a.nests());
  const eggs = useResource(admin, `eggs:${id}`, (a) => a.eggs(id));
  const nest = nests.data?.find((n) => n.id === id);
  return (
    <Screen title={nest?.name ?? t('admin.nests')} onBack={nav.pop} testID="screen-admin-nest">
      {eggs.error ? <ErrorPanel error={eggs.error} onRetry={eggs.reload} /> : null}
      {eggs.loading && !eggs.data ? <Loading /> : null}
      {(eggs.data ?? []).map((egg) => (
        <Card key={egg.id} testID={`egg-${egg.id}`}>
          <T variant="label">{egg.name}</T>
          {egg.description ? <T variant="muted">{egg.description}</T> : null}
          <KeyValue label={t('eggs.images')} value={Object.values(egg.docker_images).join('\n') || egg.docker_image || '—'} />
          <T variant="caption">{t('eggs.startup')}</T>
          <T variant="mono" selectable>
            {egg.startup}
          </T>
        </Card>
      ))}
      <T variant="caption">{t('eggs.readOnly')}</T>
    </Screen>
  );
}
