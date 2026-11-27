import { useState } from 'react';
import { Linking, View } from 'react-native';

import type { ClientApi } from '../api/client';
import { classifyFetchError, PanelError } from '../api/errors';
import type { Backup, ClientServer, Schedule, StartupVariable } from '../api/types';
import { formatBytes, formatDateTime, type Language, type Translate } from '../i18n';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import { useResource, type Resource } from '../state/useResource';
import { ActionSheet, Badge, Button, Card, ConfirmDialog, ErrorPanel, Field, KeyValue, ListRow, Loading, Notice, Screen, T, ToggleRow, styles } from '../ui/kit';
import { usePolling, useServer } from './common';

const asPanelError = (error: unknown) => (error instanceof PanelError ? error : classifyFetchError(error));

function ListState<T>({ res, empty }: { res: Resource<T[]>; empty: string }) {
  return (
    <>
      {res.error ? <ErrorPanel error={res.error} onRetry={res.reload} /> : null}
      {res.loading && !res.data ? <Loading /> : null}
      {res.data && res.data.length === 0 ? (
        <T variant="muted" testID="list-empty">
          {empty}
        </T>
      ) : null}
    </>
  );
}

/** A server sub-screen: the server view must be loaded first (daemon type on Hydrodactyl). */
function useServerList<T>(id: string, key: string, load: (c: ClientApi, s: ClientServer) => Promise<T[]>) {
  const { client } = useApp();
  const server = useServer(id);
  const s = server.data;
  const res = useResource(s ? client : null, `${key}:${id}`, (c) => load(c, s!));
  return { server: s, res };
}

// --- Databases --------------------------------------------------------------------------------

export function DatabasesScreen({ id }: { id: string }) {
  const { t } = useApp();
  const nav = useNav();
  const { server, res } = useServerList(id, 'databases', (c, s) => c.databases(s));
  return (
    <Screen title={t('server.databases')} onBack={nav.pop} testID="screen-databases">
      <T variant="caption">{server?.name ?? id}</T>
      <ListState res={res} empty={t('databases.empty')} />
      {(res.data ?? []).map((db) => (
        <Card key={db.id} testID={`database-${db.id}`}>
          <T variant="label">{db.name}</T>
          <KeyValue label={t('databases.host')} value={`${db.host.address}:${db.host.port}`} />
          <KeyValue label={t('databases.user')} value={db.username} />
          <KeyValue label={t('databases.from')} value={db.connections_from} />
        </Card>
      ))}
      <T variant="caption">{t('databases.passwordNote')}</T>
    </Screen>
  );
}

// --- Schedules --------------------------------------------------------------------------------

export function cronText(s: Schedule): string {
  const c = s.cron;
  return `${c.minute} ${c.hour} ${c.day_of_month} ${c.month} ${c.day_of_week}`;
}

export function SchedulesScreen({ id }: { id: string }) {
  const { t, client, language } = useApp();
  const nav = useNav();
  const { server, res } = useServerList(id, 'schedules', (c, s) => c.schedules(s));
  const [running, setRunning] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [notice, setNotice] = useState<string>();

  const run = async () => {
    if (!client || !server || !running) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.runSchedule(server, running.id);
      setNotice(t('schedules.triggered', { name: running.name }));
      res.reload();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
      setRunning(null);
    }
  };

  return (
    <Screen title={t('server.schedules')} onBack={nav.pop} testID="screen-schedules">
      <T variant="caption">{server?.name ?? id}</T>
      {notice ? <Notice tone="success" testID="schedules-notice">{notice}</Notice> : null}
      {error ? <ErrorPanel error={error} /> : null}
      <ListState res={res} empty={t('schedules.empty')} />
      {(res.data ?? []).map((schedule) => (
        <Card key={schedule.id} testID={`schedule-${schedule.id}`}>
          <View style={styles.rowBetween}>
            <T variant="label">{schedule.name}</T>
            <Badge label={schedule.is_processing ? t('schedules.processing') : schedule.is_active ? t('schedules.active') : t('schedules.inactive')} tone={schedule.is_active ? 'success' : 'neutral'} />
          </View>
          <T variant="mono">{cronText(schedule)}</T>
          <KeyValue label={t('schedules.lastRun')} value={formatDateTime(schedule.last_run_at ?? undefined, language)} />
          <KeyValue label={t('schedules.nextRun')} value={formatDateTime(schedule.next_run_at ?? undefined, language)} />
          <View style={{ alignSelf: 'flex-start' }}>
            <Button label={t('schedules.run')} kind="secondary" compact onPress={() => setRunning(schedule)} testID={`schedule-run-${schedule.id}`} />
          </View>
        </Card>
      ))}
      <ConfirmDialog
        visible={running !== null}
        title={t('schedules.runTitle', { name: running?.name ?? '' })}
        body={t('schedules.runBody')}
        confirmLabel={t('schedules.run')}
        danger={false}
        busy={busy}
        onCancel={() => setRunning(null)}
        onConfirm={() => void run()}
      />
    </Screen>
  );
}

// --- Backups ----------------------------------------------------------------------------------

export function backupState(b: Backup, t: Translate): { label: string; tone: 'success' | 'danger' | 'info' } {
  if (!b.completed_at) return { label: t('backups.running'), tone: 'info' };
  return b.is_successful ? { label: t('backups.ok'), tone: 'success' } : { label: t('backups.failed'), tone: 'danger' };
}

function backupSubtitle(b: Backup, language: Language): string {
  return `${formatDateTime(b.created_at, language)}${b.completed_at && b.is_successful ? ` · ${formatBytes(b.bytes, language)}` : ''}`;
}

export function BackupsScreen({ id }: { id: string }) {
  const { t, client, language } = useApp();
  const nav = useNav();
  const { server, res } = useServerList(id, 'backups', (c, s) => c.backups(s));
  const [selected, setSelected] = useState<Backup | null>(null);
  const [dialog, setDialog] = useState<'create' | 'restore' | null>(null);
  const [target, setTarget] = useState<Backup | null>(null);
  const [name, setName] = useState('');
  const [truncate, setTruncate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [notice, setNotice] = useState<string>();
  const runningOne = (res.data ?? []).some((b) => !b.completed_at);
  usePolling(res.reload, 5_000, runningOne);

  const act = async (work: () => Promise<void>, done?: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
      if (done) setNotice(done);
      res.reload();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const limit = server?.feature_limits.backups ?? 0;
  const count = res.data?.length ?? 0;

  return (
    <Screen title={t('server.backups')} onBack={nav.pop} testID="screen-backups">
      <T variant="caption">{t('backups.count', { count, limit: limit || '∞' })}</T>
      {notice ? <Notice tone="success" testID="backups-notice">{notice}</Notice> : null}
      {error ? <ErrorPanel error={error} /> : null}
      <Button label={t('backups.create')} onPress={() => (setName(''), setDialog('create'))} disabled={!server || (limit > 0 && count >= limit)} testID="backup-create" />
      {limit === 0 && server ? <T variant="caption">{t('backups.noLimit')}</T> : null}
      <ListState res={res} empty={t('backups.empty')} />
      {(res.data ?? []).map((b) => {
        const state = backupState(b, t);
        return (
          <ListRow
            key={b.uuid}
            title={`${b.is_locked ? '🔒 ' : ''}${b.name}`}
            subtitle={backupSubtitle(b, language)}
            right={<Badge label={state.label} tone={state.tone} />}
            onPress={() => setSelected(b)}
            testID={`backup-${b.uuid}`}
          />
        );
      })}
      <ActionSheet
        visible={selected !== null}
        title={selected?.name ?? ''}
        onClose={() => setSelected(null)}
        actions={
          selected && selected.completed_at && selected.is_successful
            ? [
                {
                  label: t('backups.download'),
                  testID: 'backup-download',
                  onPress: () => void act(async () => {
                    if (!client || !server) return;
                    await Linking.openURL(await client.backupDownloadUrl(server, selected.uuid));
                  }),
                },
                { label: t('backups.restore'), danger: true, testID: 'backup-restore', onPress: () => (setTarget(selected), setTruncate(false), setDialog('restore')) },
              ]
            : []
        }
      />
      <ConfirmDialog
        visible={dialog === 'create'}
        title={t('backups.create')}
        body={t('backups.createBody')}
        confirmLabel={t('common.create')}
        danger={false}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (client && server) void act(async () => void (await client.createBackup(server, name)), t('backups.started'));
        }}
      >
        <Field label={t('backups.name')} value={name} onChangeText={setName} placeholder={t('common.optional')} testID="backup-name" />
      </ConfirmDialog>
      <ConfirmDialog
        visible={dialog === 'restore'}
        title={t('backups.restoreTitle', { name: target?.name ?? '' })}
        body={t('backups.restoreBody')}
        confirmLabel={t('backups.restore')}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (client && server && target) void act(() => client.restoreBackup(server, target.uuid, truncate), t('backups.restoring'));
        }}
      >
        <ToggleRow label={t('backups.truncate')} value={truncate} onChange={setTruncate} testID="backup-truncate" />
      </ConfirmDialog>
    </Screen>
  );
}

// --- Network ----------------------------------------------------------------------------------

export function NetworkScreen({ id }: { id: string }) {
  const { t } = useApp();
  const nav = useNav();
  const { server, res } = useServerList(id, 'allocations', (c, s) => c.allocations(s));
  return (
    <Screen title={t('server.network')} onBack={nav.pop} testID="screen-network">
      <T variant="caption">{t('network.count', { count: res.data?.length ?? 0, limit: server?.feature_limits.allocations || '∞' })}</T>
      <ListState res={res} empty={t('network.empty')} />
      {(res.data ?? []).map((a) => (
        <ListRow
          key={a.id}
          title={`${a.ip_alias ?? a.ip}:${a.port}`}
          subtitle={[a.ip_alias ? a.ip : null, a.notes].filter(Boolean).join(' · ') || undefined}
          right={a.is_default ? <Badge label={t('network.primary')} tone="accent" /> : undefined}
          testID={`allocation-${a.id}`}
        />
      ))}
    </Screen>
  );
}

// --- Startup ----------------------------------------------------------------------------------

function VariableCard({ variable, onSave }: { variable: StartupVariable; onSave: (value: string) => Promise<void> }) {
  const { t } = useApp();
  const [value, setValue] = useState(variable.server_value ?? variable.default_value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [saved, setSaved] = useState(false);
  const current = variable.server_value ?? variable.default_value;
  return (
    <Card testID={`variable-${variable.env_variable}`}>
      {variable.is_editable ? (
        <Field label={variable.name} value={value} onChangeText={(next) => (setValue(next), setSaved(false))} hint={variable.description} testID={`variable-input-${variable.env_variable}`} />
      ) : (
        <>
          <T variant="label">{variable.name}</T>
          <T variant="mono">{current}</T>
          <T variant="caption">{variable.description}</T>
          <Badge label={t('startup.readOnly')} />
        </>
      )}
      <T variant="caption">{variable.env_variable}</T>
      {error ? <ErrorPanel error={error} /> : null}
      {saved ? <T variant="caption" tone="success">{t('startup.saved')}</T> : null}
      {variable.is_editable ? (
        <View style={{ alignSelf: 'flex-start' }}>
          <Button
            label={t('common.save')}
            compact
            busy={busy}
            disabled={value === current}
            testID={`variable-save-${variable.env_variable}`}
            onPress={() => {
              setBusy(true);
              setError(undefined);
              onSave(value)
                .then(() => setSaved(true))
                .catch((caught: unknown) => setError(asPanelError(caught)))
                .finally(() => setBusy(false));
            }}
          />
        </View>
      ) : null}
    </Card>
  );
}

export function StartupScreen({ id }: { id: string }) {
  const { t, client } = useApp();
  const nav = useNav();
  const server = useServer(id);
  const s = server.data;
  const res = useResource(s ? client : null, `startup:${id}`, (c) => c.startup(s!));
  return (
    <Screen title={t('server.startup')} onBack={nav.pop} testID="screen-startup">
      {res.error ? <ErrorPanel error={res.error} onRetry={res.reload} /> : null}
      {!res.data && !res.error ? <Loading /> : null}
      {res.data?.startup_command ? (
        <Card>
          <T variant="label">{t('startup.command')}</T>
          <T variant="mono" selectable testID="startup-command">
            {res.data.startup_command}
          </T>
        </Card>
      ) : null}
      {(res.data?.variables ?? []).map((variable) => (
        <VariableCard
          key={variable.env_variable}
          variable={variable}
          onSave={async (value) => {
            if (!client || !s) return;
            await client.setVariable(s, variable.env_variable, value);
            res.reload();
          }}
        />
      ))}
      <T variant="caption">{t('startup.note')}</T>
    </Screen>
  );
}

// --- Subusers ---------------------------------------------------------------------------------

export function SubusersScreen({ id }: { id: string }) {
  const { t } = useApp();
  const nav = useNav();
  const { res } = useServerList(id, 'subusers', (c, s) => c.subusers(s));
  return (
    <Screen title={t('server.subusers')} onBack={nav.pop} testID="screen-subusers">
      <ListState res={res} empty={t('subusers.empty')} />
      {(res.data ?? []).map((u) => (
        <ListRow
          key={u.uuid}
          title={u.username}
          subtitle={`${u.email} · ${t('subusers.permissions', { count: u.permissions.length })}`}
          right={<Badge label={u['2fa_enabled'] ? t('account.twoFactorOn') : t('account.twoFactorOff')} tone={u['2fa_enabled'] ? 'success' : 'warning'} />}
          testID={`subuser-${u.username}`}
        />
      ))}
      <T variant="caption">{t('subusers.note')}</T>
    </Screen>
  );
}
