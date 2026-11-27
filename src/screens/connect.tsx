import { useState } from 'react';
import { Platform, View } from 'react-native';

import { classifyFetchError, PanelError } from '../api/errors';
import { hostOf } from '../api/url';
import { useNav } from '../navigation';
import { useApp } from '../state/AppProvider';
import type { PanelAlertSettings } from '../state/panels';
import { clearResourceCache } from '../state/useResource';
import { Badge, Button, Card, ConfirmDialog, ErrorPanel, Field, ListRow, Notice, Screen, Section, T, ToggleRow } from '../ui/kit';

const asPanelError = (error: unknown) => (error instanceof PanelError ? error : classifyFetchError(error));

/** Address and keys; both are checked against the panel before anything is saved. */
export function ConnectScreen({ onDone, onBack }: { onDone?: () => void; onBack?: () => void }) {
  const { t, addPanel, secretsPersistent, theme } = useApp();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [clientKey, setClientKey] = useState('');
  const [appKey, setAppKey] = useState('');
  const [showAdmin, setShowAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await addPanel({ name, url, clientKey, applicationKey: showAdmin ? appKey : undefined });
      clearResourceCache();
      setClientKey('');
      setAppKey('');
      onDone?.();
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={onBack ? t('connect.title') : t('app.name')} onBack={onBack} testID="screen-connect">
      {!onBack ? (
        <View style={{ gap: theme.space(1), marginBottom: theme.space(2) }}>
          <T variant="muted">{t('app.tagline')}</T>
          <T variant="heading">{t('connect.title')}</T>
        </View>
      ) : null}
      {!secretsPersistent || Platform.OS === 'web' ? (
        <Notice tone="warning" testID="web-key-warning">
          {t('connect.webWarning')}
        </Notice>
      ) : null}
      <Field label={t('connect.name')} value={name} onChangeText={setName} placeholder={t('connect.namePlaceholder')} autoCapitalize="words" testID="connect-name" />
      <Field label={t('connect.url')} value={url} onChangeText={setUrl} placeholder="panel.example.org" keyboard="url" hint={t('connect.urlHint')} testID="connect-url" />
      <Field label={t('connect.clientKey')} value={clientKey} onChangeText={setClientKey} secure hint={t('connect.clientKeyHint')} testID="connect-key" />
      {error && error.field !== 'application' ? <ErrorPanel error={error} /> : null}
      <ToggleRow label={t('connect.adminToggle')} value={showAdmin} onChange={setShowAdmin} testID="connect-admin" />
      {showAdmin ? (
        <>
          <Field label={t('connect.appKey')} value={appKey} onChangeText={setAppKey} secure hint={t('connect.appKeyHint')} testID="connect-app-key" />
          {error?.field === 'application' ? <ErrorPanel error={error} /> : null}
        </>
      ) : null}
      <Button
        label={busy ? t('connect.checking') : t('connect.submit')}
        onPress={submit}
        busy={busy}
        disabled={url.trim() === '' || clientKey.trim() === '' || (showAdmin && appKey.trim() === '')}
        testID="connect-submit"
      />
      {secretsPersistent ? <T variant="caption">{t('connect.secureNote')}</T> : null}
      <T variant="caption">{t('app.notAffiliated')}</T>
    </Screen>
  );
}

export function PanelsScreen() {
  const { t, panels, active, selectPanel } = useApp();
  const nav = useNav();
  return (
    <Screen title={t('panels.title')} onBack={nav.pop} testID="screen-panels">
      {panels.map((panel) => (
        <ListRow
          key={panel.id}
          title={panel.name}
          subtitle={`${hostOf(panel.origin)} · ${panel.flavor === 'hydrodactyl' ? 'Hydrodactyl' : 'Pterodactyl'} · ${panel.username}`}
          onPress={() => {
            selectPanel(panel.id);
            nav.push({ name: 'panelSettings', id: panel.id });
          }}
          right={panel.id === active?.id ? <Badge label={t('panels.active')} tone="success" /> : undefined}
          testID={`panel-${panel.id}`}
        />
      ))}
      <Button label={t('panels.add')} onPress={() => nav.push({ name: 'connect' })} testID="panels-add" />
    </Screen>
  );
}

/** One panel: name, flavour, the application key, its alert settings and removal. */
export function PanelSettingsScreen({ id }: { id: string }) {
  const { t, panels, updatePanel, setApplicationKey, removePanel } = useApp();
  const nav = useNav();
  const panel = panels.find((p) => p.id === id);
  const [appKey, setAppKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError>();
  const [removing, setRemoving] = useState(false);
  if (!panel) return <Screen title={t('panels.title')} onBack={nav.pop}>{null}</Screen>;

  const setAlert = (patch: Partial<PanelAlertSettings>) => void updatePanel(panel.id, { alerts: { ...panel.alerts, ...patch } });

  const saveKey = async (key: string | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await setApplicationKey(panel.id, key);
      clearResourceCache();
      setAppKey('');
    } catch (caught) {
      setError(asPanelError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title={panel.name} onBack={nav.pop} testID="screen-panel-settings">
      <Card>
        <T variant="label">{hostOf(panel.origin)}</T>
        <T variant="caption" testID="panel-flavor">
          {panel.flavor === 'hydrodactyl' ? t('panels.hydrodactyl', { version: panel.version ?? '?' }) : t('panels.pterodactyl')}
        </T>
        <T variant="caption">{t('panels.account', { name: panel.username })}</T>
      </Card>

      <Section title={t('panels.adminKey')}>
        <Card>
          {panel.hasApplicationKey ? (
            <>
              <Badge label={t('panels.adminKeySaved')} tone="success" testID="app-key-saved" />
              <Button label={t('panels.adminKeyRemove')} kind="ghost" compact onPress={() => void saveKey(null)} testID="app-key-remove" />
            </>
          ) : (
            <>
              <T variant="muted">{t('panels.adminKeyHint')}</T>
              <Field label={t('connect.appKey')} value={appKey} onChangeText={setAppKey} secure testID="app-key" />
              {error ? <ErrorPanel error={error} /> : null}
              <Button label={t('panels.adminKeySave')} onPress={() => void saveKey(appKey)} busy={busy} disabled={appKey.trim() === ''} testID="app-key-save" />
            </>
          )}
        </Card>
      </Section>

      <Section title={t('panels.alerts')}>
        <Card>
          <ToggleRow label={t('panels.alertsEnabled')} value={panel.alerts.enabled} onChange={(enabled) => setAlert({ enabled })} testID="alerts-enabled" />
          <ToggleRow label={t('panels.alertsOffline')} value={panel.alerts.offline} onChange={(offline) => setAlert({ offline })} testID="alerts-offline" />
          <ToggleRow label={t('panels.alertsResources')} value={panel.alerts.resources} onChange={(resources) => setAlert({ resources })} />
          <ToggleRow label={t('panels.alertsBackups')} value={panel.alerts.backups} onChange={(backups) => setAlert({ backups })} />
          <ToggleRow label={t('panels.alertsNodes')} value={panel.alerts.nodes} onChange={(nodes) => setAlert({ nodes })} />
          {!panel.hasApplicationKey ? <T variant="caption">{t('panels.alertsNodesHint')}</T> : null}
        </Card>
      </Section>

      <Button label={t('panels.remove')} kind="danger" onPress={() => setRemoving(true)} testID="panel-remove" />
      <ConfirmDialog
        visible={removing}
        title={t('panels.removeTitle', { name: panel.name })}
        body={t('panels.removeBody')}
        confirmLabel={t('panels.remove')}
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          setRemoving(false);
          void removePanel(panel.id).then(() => nav.pop());
        }}
      />
    </Screen>
  );
}

/** Shown instead of a screen's content when the active panel's key is not available. */
export function NeedsKey() {
  const { t, active } = useApp();
  const nav = useNav();
  return (
    <Notice tone="warning" testID="needs-key">
      <T>{t('panels.needsKey')}</T>
      <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
        <Button label={t('connect.title')} compact onPress={() => nav.push({ name: 'connect' })} />
      </View>
      {active ? <T variant="caption">{hostOf(active.origin)}</T> : null}
    </Notice>
  );
}
