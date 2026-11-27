import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { classifyFetchError, PanelError } from '../api/errors';
import type { AppServer, PanelUser } from '../api/types';
import { formatBytes, formatDate, formatDuration, formatMiB } from '../i18n';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import { useResource } from '../state/useResource';
import { Badge, Button, Card, ConfirmDialog, ErrorPanel, Field, KeyValue, ListRow, Loading, Meter, Notice, Screen, SearchBar, Section, T, ToggleRow } from '../ui/kit';
import { stateBadge } from './common';

const asPanelError = (error: unknown) => (error instanceof PanelError ? error : classifyFetchError(error));

export function useDebounced<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Shown on admin screens while the panel has no application key. */
export function NeedsAppKey() {
  const { t, active } = useApp();
  const nav = useNav();
  return (
    <Notice tone="info" testID="needs-app-key">
      <T>{t('admin.needsKey')}</T>
      {active ? (
        <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
          <Button label={t('panels.adminKeySave')} compact onPress={() => nav.push({ name: 'panelSettings', id: active.id })} testID="add-app-key" />
        </View>
      ) : null}
    </Notice>
  );
}

export function AdminScreen() {
  const { t, admin, active, language } = useApp();
  const nav = useNav();
  const status = useResource(admin && active?.flavor === 'hydrodactyl' ? admin : null, 'panelStatus', (a) => a.panelStatus());
  const m = status.data?.metrics;
  const rows: { route: 'adminUsers' | 'adminServers' | 'adminNodes' | 'adminLocations' | 'adminNests'; label: Parameters<typeof t>[0] }[] = [
    { route: 'adminUsers', label: 'admin.users' },
    { route: 'adminServers', label: 'admin.servers' },
    { route: 'adminNodes', label: 'admin.nodes' },
    { route: 'adminLocations', label: 'admin.locations' },
    { route: 'adminNests', label: 'admin.nests' },
  ];
  return (
    <Screen title={t('admin.title')} testID="screen-admin">
      {!admin ? <NeedsAppKey /> : null}
      {admin
        ? rows.map(({ route, label }) => <ListRow key={route} title={t(label)} onPress={() => nav.push({ name: route })} testID={`admin-${route}`} />)
        : null}
      {m ? (
        <Section title={t('admin.panelHost')}>
          <Card testID="panel-status">
            <Meter label={t('server.cpu')} percent={m.cpu} detail={t('admin.cores', { count: m.cpu_cores })} />
            <Meter label={t('server.memory')} percent={m.memory.total ? (m.memory.used / m.memory.total) * 100 : 0} detail={`${formatBytes(m.memory.used, language)} / ${formatBytes(m.memory.total, language)}`} />
            <Meter label={t('server.disk')} percent={m.disk.total ? (m.disk.used / m.disk.total) * 100 : 0} detail={`${formatBytes(m.disk.used, language)} / ${formatBytes(m.disk.total, language)}`} warnAt={90} />
            <KeyValue label={t('admin.uptime')} value={formatDuration(m.uptime * 1000, language)} />
            <T variant="caption">{t('admin.panelHostNote')}</T>
          </Card>
        </Section>
      ) : null}
      {status.error ? <ErrorPanel error={status.error} /> : null}
    </Screen>
  );
}

// --- Users ------------------------------------------------------------------------------------

export function AdminUsersScreen() {
  const { t, admin } = useApp();
  const nav = useNav();
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const users = useResource(admin, `users:${search}`, (a) => a.users(search));
  return (
    <Screen title={t('admin.users')} onBack={nav.pop} right={admin ? <Button label="+" compact onPress={() => nav.push({ name: 'adminUserForm' })} testID="create" /> : undefined} testID="screen-admin-users">
      {!admin ? <NeedsAppKey /> : null}
      <SearchBar value={query} onChange={setQuery} placeholder={t('admin.searchUsers')} />
      {users.error ? <ErrorPanel error={users.error} onRetry={users.reload} /> : null}
      {users.loading && !users.data ? <Loading /> : null}
      {users.data && users.data.length === 0 ? <T variant="muted" testID="list-empty">{t('common.noMatch', { query: search })}</T> : null}
      {(users.data ?? []).map((u) => (
        <ListRow
          key={u.id}
          title={u.username}
          subtitle={`${u.first_name} ${u.last_name} · ${u.email}`}
          right={u.root_admin ? <Badge label={t('admin.rootAdmin')} tone="accent" /> : undefined}
          onPress={() => nav.push({ name: 'adminUser', id: u.id })}
          testID={`row-user-${u.id}`}
        />
      ))}
    </Screen>
  );
}

export function AdminUserScreen({ id }: { id: number }) {
  const { t, admin, language } = useApp();
  const nav = useNav();
  const user = useResource(admin, `user:${id}`, (a) => a.user(id));
  const servers = useResource(admin, 'adminServers', (a) => a.servers());
  const owned = useMemo(() => (servers.data ?? []).filter((s) => s.user === id), [servers.data, id]);
  const [dialog, setDialog] = useState<'suspend' | 'unsuspend' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const u = user.data;

  const setAll = async (suspend: boolean) => {
    if (!admin) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const s of owned) {
        if (s.suspended !== suspend) await (suspend ? admin.suspend(s.id) : admin.unsuspend(s.id));
      }
      servers.reload();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  return (
    <Screen title={u?.username ?? String(id)} onBack={nav.pop} testID="screen-admin-user">
      {user.error ? <ErrorPanel error={user.error} onRetry={user.reload} /> : null}
      {!u && !user.error ? <Loading /> : null}
      {u ? (
        <>
          <Card>
            <KeyValue label={t('admin.name')} value={`${u.first_name} ${u.last_name}`} />
            <KeyValue label={t('admin.email')} value={u.email} />
            <KeyValue label={t('admin.role')} value={u.root_admin ? t('admin.rootAdmin') : t('admin.user')} />
            <KeyValue label={t('account.twoFactor')} value={<Badge label={u['2fa'] ? t('account.twoFactorOn') : t('account.twoFactorOff')} tone={u['2fa'] ? 'success' : 'warning'} testID="user-2fa" />} />
            <KeyValue label={t('admin.created')} value={formatDate(u.created_at, language)} />
          </Card>
          <Button label={t('common.edit')} kind="secondary" onPress={() => nav.push({ name: 'adminUserForm', id })} testID="user-edit" />
          <Section title={t('admin.ownedServers', { count: owned.length })}>
            {owned.map((s) => (
              <ListRow key={s.id} title={s.name} subtitle={s.identifier} right={s.suspended ? <Badge label={t('server.suspended')} tone="danger" /> : undefined} onPress={() => nav.push({ name: 'adminServer', id: s.id })} testID={`user-server-${s.id}`} />
            ))}
            {error ? <ErrorPanel error={error} /> : null}
            {owned.length > 0 ? (
              <View style={{ gap: 8 }}>
                <Button label={t('admin.suspendAll')} kind="danger" onPress={() => setDialog('suspend')} testID="user-suspend" />
                <Button label={t('admin.unsuspendAll')} kind="secondary" onPress={() => setDialog('unsuspend')} testID="user-unsuspend" />
              </View>
            ) : null}
            <T variant="caption">{t('admin.suspendNote')}</T>
          </Section>
        </>
      ) : null}
      <ConfirmDialog
        visible={dialog !== null}
        title={dialog === 'suspend' ? t('admin.suspendAllTitle', { name: u?.username ?? '' }) : t('admin.unsuspendAllTitle', { name: u?.username ?? '' })}
        body={dialog === 'suspend' ? t('admin.suspendAllBody', { count: owned.length }) : t('admin.unsuspendAllBody', { count: owned.length })}
        confirmLabel={dialog === 'suspend' ? t('admin.suspend') : t('admin.unsuspend')}
        danger={dialog === 'suspend'}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void setAll(dialog === 'suspend')}
      />
    </Screen>
  );
}

export function AdminUserFormScreen({ id }: { id?: number }) {
  const { t, admin } = useApp();
  const nav = useNav();
  const existing = useResource(id !== undefined ? admin : null, `user:${id}`, (a) => a.user(id as number));
  const [form, setForm] = useState({ email: '', username: '', first_name: '', last_name: '', password: '', root_admin: false });
  const [loaded, setLoaded] = useState(id === undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();

  useEffect(() => {
    const u: PanelUser | undefined = existing.data;
    if (u && !loaded) {
      setForm({ email: u.email, username: u.username, first_name: u.first_name, last_name: u.last_name, password: '', root_admin: u.root_admin });
      setLoaded(true);
    }
  }, [existing.data, loaded]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    if (!admin) return;
    setBusy(true);
    setError(undefined);
    const body = { ...form, password: form.password.trim() || undefined };
    try {
      if (id === undefined) await admin.createUser(body);
      else await admin.updateUser(id, body);
      nav.pop();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={id === undefined ? t('admin.newUser') : t('admin.editUser')} onBack={nav.pop} testID="screen-user-form">
      {existing.error ? <ErrorPanel error={existing.error} onRetry={existing.reload} /> : null}
      {!loaded ? <Loading /> : null}
      {loaded ? (
        <>
          <Field label={t('admin.email')} value={form.email} onChangeText={(email) => set({ email })} keyboard="email-address" testID="user-email" />
          <Field label={t('admin.username')} value={form.username} onChangeText={(username) => set({ username })} testID="user-username" />
          <Field label={t('admin.firstName')} value={form.first_name} onChangeText={(first_name) => set({ first_name })} autoCapitalize="words" testID="user-first" />
          <Field label={t('admin.lastName')} value={form.last_name} onChangeText={(last_name) => set({ last_name })} autoCapitalize="words" testID="user-last" />
          <Field label={t('admin.password')} value={form.password} onChangeText={(password) => set({ password })} secure hint={id === undefined ? t('admin.passwordNewHint') : t('admin.passwordEditHint')} testID="user-password" />
          <ToggleRow label={t('admin.rootAdmin')} value={form.root_admin} onChange={(root_admin) => set({ root_admin })} testID="user-admin" />
        </>
      ) : null}
      {error ? <ErrorPanel error={error} /> : null}
      <Button label={id === undefined ? t('common.create') : t('common.save')} onPress={() => void submit()} busy={busy} disabled={!admin || !form.email || !form.username || !form.first_name || !form.last_name} testID="form-submit" />
    </Screen>
  );
}

// --- Servers ----------------------------------------------------------------------------------

export function AdminServersScreen() {
  const { t, admin } = useApp();
  const nav = useNav();
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const servers = useResource(admin, `adminServers${search ? `:${search}` : ''}`, (a) => a.servers(search));
  return (
    <Screen title={t('admin.servers')} onBack={nav.pop} testID="screen-admin-servers">
      {!admin ? <NeedsAppKey /> : null}
      <SearchBar value={query} onChange={setQuery} placeholder={t('servers.search')} />
      {servers.error ? <ErrorPanel error={servers.error} onRetry={servers.reload} /> : null}
      {servers.loading && !servers.data ? <Loading /> : null}
      {(servers.data ?? []).map((s) => {
        const badge = stateBadge(t, undefined, s.status);
        return (
          <ListRow
            key={s.id}
            title={s.name}
            subtitle={s.identifier}
            right={s.status ? <Badge label={badge.label} tone={badge.tone} /> : undefined}
            onPress={() => nav.push({ name: 'adminServer', id: s.id })}
            testID={`row-admin-server-${s.id}`}
          />
        );
      })}
    </Screen>
  );
}

export function AdminServerScreen({ id }: { id: number }) {
  const { t, admin, language } = useApp();
  const nav = useNav();
  const server = useResource(admin, `adminServer:${id}`, (a) => a.server(id));
  const users = useResource(admin, 'users:', (a) => a.users(''));
  const nodes = useResource(admin, 'nodes', (a) => a.nodes());
  const [dialog, setDialog] = useState<'suspend' | 'unsuspend' | 'reinstall' | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [notice, setNotice] = useState<string>();
  const s: AppServer | undefined = server.data;
  const owner = users.data?.find((u) => u.id === s?.user);
  const node = nodes.data?.find((n) => n.id === s?.node);
  const badge = stateBadge(t, undefined, s?.status);

  const run = async () => {
    if (!admin || !s || !dialog) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (dialog === 'suspend') await admin.suspend(s.id);
      if (dialog === 'unsuspend') await admin.unsuspend(s.id);
      if (dialog === 'reinstall') await admin.reinstall(s.id);
      setNotice(t(`admin.${dialog}Done`, { name: s.name }));
      server.reload();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  return (
    <Screen title={s?.name ?? String(id)} onBack={nav.pop} testID="screen-admin-server">
      {server.error ? <ErrorPanel error={server.error} onRetry={server.reload} /> : null}
      {!s && !server.error ? <Loading /> : null}
      {s ? (
        <>
          <Card>
            <Badge label={s.status ? badge.label : t('admin.active')} tone={s.status ? badge.tone : 'success'} testID="admin-server-state" />
            {s.description ? <T variant="muted">{s.description}</T> : null}
            <KeyValue label={t('server.identifier')} value={s.identifier} />
            <KeyValue label={t('server.owner')} value={owner ? `${owner.username} (${owner.email})` : String(s.user)} />
            <KeyValue label={t('server.node')} value={node?.name ?? String(s.node)} />
            <KeyValue label={t('server.memory')} value={formatMiB(s.limits.memory, language, t('common.unlimited'))} />
            <KeyValue label={t('server.disk')} value={formatMiB(s.limits.disk, language, t('common.unlimited'))} />
            <KeyValue label={t('server.cpu')} value={s.limits.cpu ? `${s.limits.cpu} %` : t('common.unlimited')} />
            <KeyValue label={t('server.image')} value={s.container.image} />
            <KeyValue label={t('admin.created')} value={formatDate(s.created_at, language)} />
          </Card>
          {notice ? <Notice tone="success" testID="admin-server-notice">{notice}</Notice> : null}
          {error ? <ErrorPanel error={error} /> : null}
          {s.suspended ? (
            <Button label={t('admin.unsuspend')} onPress={() => setDialog('unsuspend')} testID="server-unsuspend" />
          ) : (
            <Button label={t('admin.suspend')} kind="danger" onPress={() => setDialog('suspend')} testID="server-suspend" />
          )}
          <Button label={t('admin.reinstall')} kind="secondary" onPress={() => (setConfirmName(''), setDialog('reinstall'))} testID="server-reinstall" />
        </>
      ) : null}
      <ConfirmDialog
        visible={dialog !== null}
        title={dialog ? t(`admin.${dialog}Title`, { name: s?.name ?? '' }) : ''}
        body={dialog ? t(`admin.${dialog}Body`) : ''}
        confirmLabel={dialog ? t(`admin.${dialog}`) : ''}
        danger={dialog !== 'unsuspend'}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          // A reinstall can overwrite files: the server's name has to be typed first.
          if (dialog === 'reinstall' && confirmName.trim() !== s?.name) return;
          void run();
        }}
      >
        {dialog === 'reinstall' ? <Field label={t('admin.typeName', { name: s?.name ?? '' })} value={confirmName} onChangeText={setConfirmName} testID="confirm-name" /> : null}
      </ConfirmDialog>
    </Screen>
  );
}
