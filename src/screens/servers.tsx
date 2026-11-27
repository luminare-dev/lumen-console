import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { PanelError, classifyFetchError } from '../api/errors';
import type { ClientServer, PowerSignal } from '../api/types';
import { formatBytes, formatDuration, formatMiB, formatNumber } from '../i18n';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import { useResource } from '../state/useResource';
import { Badge, Button, Card, ConfirmDialog, ErrorPanel, KeyValue, ListRow, Loading, Meter, Notice, Screen, SearchBar, Section, Sparkline, T, styles } from '../ui/kit';
import { percentOf, stateBadge, usePolling, useServer } from './common';
import { NeedsKey } from './connect';

function ServerRow({ server }: { server: ClientServer }) {
  const { t, client, language } = useApp();
  const nav = useNav();
  const watch = server.status === null;
  const res = useResource(watch ? client : null, `resources:${server.identifier}`, (c) => c.resources(server.identifier));
  const r = res.data;
  const badge = stateBadge(t, r?.current_state, server.status, res.error?.kind === 'daemon');
  const parts = [server.node];
  if (r && r.current_state !== 'offline') {
    parts.push(`${formatNumber(r.resources.cpu_absolute, language)} % CPU`);
    parts.push(`${formatBytes(r.resources.memory_bytes, language)} / ${formatMiB(server.limits.memory, language, '∞')}`);
  }
  return (
    <ListRow
      title={server.name}
      subtitle={parts.join(' · ')}
      right={<Badge label={badge.label} tone={badge.tone} testID={`state-${server.identifier}`} />}
      onPress={() => nav.push({ name: 'server', id: server.identifier })}
      testID={`row-server-${server.identifier}`}
    />
  );
}

export function ServersScreen() {
  const { t, client, active } = useApp();
  const nav = useNav();
  const [query, setQuery] = useState('');
  const list = useResource(client, 'servers', (c) => c.servers());
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data ?? []).filter((s) => !q || `${s.name} ${s.identifier} ${s.node} ${s.description}`.toLowerCase().includes(q));
  }, [list.data, query]);

  return (
    <Screen
      title={active?.name ?? t('servers.title')}
      testID="screen-servers"
      right={<Button label={t('panels.switch')} kind="ghost" compact onPress={() => nav.push({ name: 'panels' })} testID="switch-panel" />}
    >
      {!client ? <NeedsKey /> : null}
      {active?.flavor === 'hydrodactyl' ? <Badge label={t('panels.hydrodactyl', { version: active.version ?? '?' })} tone="info" testID="flavor-badge" /> : null}
      <SearchBar value={query} onChange={setQuery} placeholder={t('servers.search')} />
      {list.error ? <ErrorPanel error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && shown.length === 0 ? <T variant="muted" testID="list-empty">{query ? t('common.noMatch', { query }) : t('servers.empty')}</T> : null}
      {shown.map((server) => (
        <ServerRow key={server.identifier} server={server} />
      ))}
      {list.data ? (
        <Button label={t('common.refresh')} kind="ghost" onPress={list.reload} testID="refresh" />
      ) : null}
    </Screen>
  );
}

const SIGNALS: { signal: PowerSignal; kind: 'primary' | 'secondary' | 'danger' }[] = [
  { signal: 'start', kind: 'primary' },
  { signal: 'restart', kind: 'secondary' },
  { signal: 'stop', kind: 'secondary' },
  { signal: 'kill', kind: 'danger' },
];

/** Start, restart, stop and kill; each asks first. */
export function PowerControls({ server, onDone }: { server: ClientServer; onDone: () => void }) {
  const { t, client, theme } = useApp();
  const [pending, setPending] = useState<PowerSignal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();

  const run = async () => {
    if (!client || !pending) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.power(server, pending);
      onDone();
    } catch (caught) {
      setError(caught instanceof PanelError ? caught : classifyFetchError(caught));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  return (
    <View style={{ gap: theme.space(2) }}>
      <View style={[styles.row, { gap: theme.space(2), flexWrap: 'wrap' }]}>
        {SIGNALS.map(({ signal, kind }) => (
          <Button key={signal} label={t(`power.${signal}`)} kind={kind} compact onPress={() => setPending(signal)} testID={`power-${signal}`} />
        ))}
      </View>
      {error ? <ErrorPanel error={error} /> : null}
      <ConfirmDialog
        visible={pending !== null}
        title={pending ? t(`power.${pending}Title`, { name: server.name }) : ''}
        body={pending ? t(`power.${pending}Body`) : ''}
        confirmLabel={pending ? t(`power.${pending}`) : ''}
        danger={pending === 'kill' || pending === 'stop'}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void run()}
      />
    </View>
  );
}

export function ServerScreen({ id }: { id: string }) {
  const { t, client, language, active } = useApp();
  const nav = useNav();
  const server = useServer(id);
  const s = server.data;
  const watch = s !== undefined && s.status === null;
  const res = useResource(watch ? client : null, `resources:${id}`, (c) => c.resources(id));
  usePolling(res.reload, 10_000, watch);
  const history = useResource(active?.flavor === 'hydrodactyl' && watch ? client : null, `history:${id}`, (c) => c.resourceHistory(id));
  const r = res.data;
  const badge = stateBadge(t, r?.current_state, s?.status, res.error?.kind === 'daemon');

  const sections: { route: 'console' | 'files' | 'databases' | 'schedules' | 'backups' | 'network' | 'startup' | 'subusers'; label: Parameters<typeof t>[0] }[] = [
    { route: 'console', label: 'server.console' },
    { route: 'files', label: 'server.files' },
    { route: 'backups', label: 'server.backups' },
    { route: 'databases', label: 'server.databases' },
    { route: 'schedules', label: 'server.schedules' },
    { route: 'network', label: 'server.network' },
    { route: 'startup', label: 'server.startup' },
    { route: 'subusers', label: 'server.subusers' },
  ];

  return (
    <Screen title={s?.name ?? id} onBack={nav.pop} testID="screen-server">
      {server.error ? <ErrorPanel error={server.error} onRetry={server.reload} /> : null}
      {!s ? <Loading /> : null}
      {s ? (
        <>
          <Card testID="card-state">
            <View style={styles.rowBetween}>
              <Badge label={badge.label} tone={badge.tone} testID="server-state" />
              <T variant="caption">{r && r.current_state !== 'offline' ? t('server.uptime', { time: formatDuration(r.resources.uptime, language) }) : s.node}</T>
            </View>
            {s.description ? <T variant="muted">{s.description}</T> : null}
            {res.error && res.error.kind !== 'conflict' ? <ErrorPanel error={res.error} onRetry={res.reload} /> : null}
            {r ? (
              <>
                <Meter label={t('server.cpu')} percent={s.limits.cpu ? (r.resources.cpu_absolute / s.limits.cpu) * 100 : Math.min(100, r.resources.cpu_absolute)} detail={`${formatNumber(r.resources.cpu_absolute, language)} % / ${s.limits.cpu ? `${s.limits.cpu} %` : t('common.unlimited')}`} testID="meter-cpu" />
                <Meter
                  label={t('server.memory')}
                  percent={percentOf(r.resources.memory_bytes, s.limits.memory) ?? 0}
                  detail={`${formatBytes(r.resources.memory_bytes, language)} / ${formatMiB(s.limits.memory, language, t('common.unlimited'))}`}
                  warnAt={95}
                  testID="meter-memory"
                />
                <Meter
                  label={t('server.disk')}
                  percent={percentOf(r.resources.disk_bytes, s.limits.disk) ?? 0}
                  detail={`${formatBytes(r.resources.disk_bytes, language)} / ${formatMiB(s.limits.disk, language, t('common.unlimited'))}`}
                  warnAt={90}
                  testID="meter-disk"
                />
                <KeyValue label={t('server.network')} value={`↓ ${formatBytes(r.resources.network_rx_bytes, language)} · ↑ ${formatBytes(r.resources.network_tx_bytes, language)}`} />
              </>
            ) : null}
            {history.data && history.data.length > 1 ? (
              <Sparkline values={history.data.map((h) => h.cpu_absolute)} label={t('server.cpuHistory')} testID="cpu-history" />
            ) : null}
          </Card>
          {s.status === null ? <PowerControls server={s} onDone={res.reload} /> : <Notice tone="warning">{t('server.notAvailable')}</Notice>}
          <Section title={t('server.manage')}>
            {sections.map(({ route, label }) => (
              <ListRow
                key={route}
                title={t(label)}
                onPress={() => nav.push(route === 'files' ? { name: 'files', id, dir: '/' } : { name: route, id })}
                testID={`open-${route}`}
              />
            ))}
          </Section>
          <Section title={t('server.details')}>
            <Card>
              <KeyValue label={t('server.identifier')} value={s.identifier} />
              <KeyValue label={t('server.node')} value={s.node} />
              <KeyValue label="SFTP" value={`${s.sftp_details.ip}:${s.sftp_details.port}`} />
              {s.docker_image ? <KeyValue label={t('server.image')} value={s.docker_image} /> : null}
              <KeyValue label={t('server.owner')} value={s.server_owner ? t('common.yes') : t('server.subuser')} />
            </Card>
          </Section>
        </>
      ) : null}
    </Screen>
  );
}
