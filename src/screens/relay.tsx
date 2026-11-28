// Settings → Push relay: pair this device with a Lumen Console Relay (address + pairing code, or
// the QR code from `lumen-relay pair`, which opens this screen filled in), choose the events per
// panel, send a test push and unregister. The local background check stays on as a fallback.

import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import appConfig from '../../app.json';
import { useNav } from '../navigation';
import { RELAY_EVENTS, RelayClient, RelayError, type RelayDeviceView, type RelayEvent, type RelayInfo, type RelayTransport } from '../relay/client';
import { clearRelay, loadRelay, ntfySubscribeLink, RELAY_TOKEN, saveRelay, watchedOrigins, type RelayEntry } from '../relay/state';
import { useApp } from '../state/AppProvider';
import { Badge, Button, Card, ConfirmDialog, Field, KeyValue, Loading, Notice, Screen, Section, Segmented, T, ToggleRow } from '../ui/kit';

type EventKey = 'relay.eventOffline' | 'relay.eventResources' | 'relay.eventBackups' | 'relay.eventNodes';
const EVENT_LABEL: Record<RelayEvent, EventKey> = {
  offline: 'relay.eventOffline',
  resources: 'relay.eventResources',
  backups: 'relay.eventBackups',
  nodes: 'relay.eventNodes',
};

/** An Expo push token; needs a build with an EAS project id (app.json extra.eas.projectId). */
async function expoPushToken(): Promise<string> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new RelayError(0, 'permission', 'notifications are not allowed');
  const extra = (appConfig.expo as unknown as { extra?: { eas?: { projectId?: string } } }).extra;
  const projectId = extra?.eas?.projectId;
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return token.data;
  } catch {
    throw new RelayError(0, 'expoToken', 'no Expo push token');
  }
}

export function RelayScreen({ url: initialUrl, code: initialCode }: { url?: string; code?: string }) {
  const { t, theme, store, secrets, language, panels } = useApp();
  const nav = useNav();
  const [entry, setEntry] = useState<RelayEntry | null | undefined>(undefined);
  const [view, setView] = useState<RelayDeviceView | null>(null);
  const [url, setUrl] = useState(initialUrl ?? '');
  const [code, setCode] = useState(initialCode ?? '');
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [transport, setTransport] = useState<RelayTransport>('ntfy');
  const [choices, setChoices] = useState<Record<string, RelayEvent[]>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string }>();
  const [confirm, setConfirm] = useState(false);

  const explain = useCallback(
    (error: unknown): string => {
      const e = error instanceof RelayError ? error : new RelayError(0, 'network', String(error));
      switch (e.code) {
        case 'insecure':
          return t('relay.errorInsecure');
        case 'invalidUrl':
          return t('relay.errorUrl');
        case 'network':
          return t('relay.errorNetwork');
        case 'pairing':
          return t('relay.errorPairing');
        case 'rateLimited':
        case 'pairingLocked':
          return t('relay.errorRate');
        case 'permission':
          return t('relay.errorPermission');
        case 'expoToken':
          return t('relay.errorExpo');
        default:
          return `${t('relay.errorOther')} ${e.message}`;
      }
    },
    [t]
  );

  const clientFor = useCallback(async (e: RelayEntry) => new RelayClient(e.url, { token: (await secrets.get(RELAY_TOKEN)) ?? undefined }), [secrets]);

  const applyView = useCallback(
    async (e: RelayEntry, v: RelayDeviceView) => {
      setView(v);
      setChoices(Object.fromEntries(v.panels.map((p) => [p.id, p.events])));
      const next = { ...e, watchedOrigins: watchedOrigins(v.panels), ntfyTopic: v.device.ntfyTopic ?? e.ntfyTopic, ntfyUrl: v.relay.ntfy?.url ?? e.ntfyUrl };
      setEntry(next);
      await saveRelay(store, secrets, next);
    },
    [store, secrets]
  );

  useEffect(() => {
    void (async () => {
      const e = await loadRelay(store);
      setEntry(e);
      if (!e) return;
      try {
        await applyView(e, await (await clientFor(e)).device());
      } catch (error) {
        setMessage({ tone: 'warning', text: explain(error) });
      }
    })();
  }, [store, applyView, clientFor, explain]);

  const check = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const i = await new RelayClient(url).info();
      setInfo(i);
      setTransport(i.transports.includes('ntfy') ? 'ntfy' : 'expo');
    } catch (error) {
      setInfo(null);
      setMessage({ tone: 'danger', text: explain(error) });
    } finally {
      setBusy(false);
    }
  };

  const pair = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const client = new RelayClient(url);
      const address = transport === 'expo' ? await expoPushToken() : undefined;
      const result = await client.register({
        pairing: code,
        transport,
        address,
        platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other',
        language,
        label: `${appConfig.expo.name} (${Platform.OS})`,
      });
      const e: RelayEntry = {
        url: client.url,
        deviceId: result.deviceId,
        transport,
        ntfyTopic: result.device.ntfyTopic,
        ntfyUrl: result.relay.ntfy?.url,
        watchedOrigins: watchedOrigins(result.panels),
        pairedAt: new Date().toISOString(),
      };
      await saveRelay(store, secrets, e, result.deviceToken);
      await applyView(e, result);
      setCode('');
      setMessage({ tone: 'success', text: t('relay.paired') });
    } catch (error) {
      setMessage({ tone: 'danger', text: explain(error) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      const client = await clientFor(entry);
      const patch: Parameters<RelayClient['update']>[0] = { subscriptions: choices, language };
      if (entry.transport === 'expo' && view?.device.disabled) patch.address = await expoPushToken();
      await applyView(entry, await client.update(patch));
      setMessage({ tone: 'success', text: t('relay.saved') });
    } catch (error) {
      setMessage({ tone: 'danger', text: explain(error) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await (await clientFor(entry)).test();
      setMessage({ tone: 'success', text: t('relay.testSent') });
    } catch (error) {
      setMessage({ tone: 'danger', text: explain(error) });
    } finally {
      setBusy(false);
    }
  };

  const unregister = async () => {
    if (!entry) return;
    setBusy(true);
    try {
      await (await clientFor(entry)).unregister();
    } catch {
      // the relay may be gone; the device is forgotten here anyway
    }
    await clearRelay(store, secrets);
    setEntry(null);
    setView(null);
    setInfo(null);
    setConfirm(false);
    setBusy(false);
    setMessage({ tone: 'success', text: t('relay.unregistered') });
  };

  const toggle = (panelId: string, event: RelayEvent, on: boolean) =>
    setChoices((c) => {
      const current = c[panelId] ?? [];
      return { ...c, [panelId]: on ? RELAY_EVENTS.filter((e) => e === event || current.includes(e)) : current.filter((e) => e !== event) };
    });

  const notice = message ? (
    <Notice tone={message.tone} testID="relay-message">
      {message.text}
    </Notice>
  ) : null;

  if (entry === undefined) {
    return (
      <Screen title={t('relay.title')} onBack={nav.pop} testID="screen-relay">
        <Loading />
      </Screen>
    );
  }

  if (!entry) {
    return (
      <Screen title={t('relay.title')} onBack={nav.pop} testID="screen-relay">
        <T variant="muted">{t('relay.intro')}</T>
        <Card>
          <Field label={t('relay.url')} value={url} onChangeText={setUrl} keyboard="url" autoCapitalize="none" placeholder="https://relay.example.org" testID="relay-url" />
          <Field label={t('relay.code')} value={code} onChangeText={setCode} autoCapitalize="none" placeholder="K7QM-XW3D-PA9T" hint={t('relay.codeHint')} testID="relay-code" />
          {info ? (
            <View style={{ gap: theme.space(2) }}>
              <T variant="caption">{t('relay.found', { version: info.version, seconds: info.pollSeconds })}</T>
              {info.transports.length > 1 ? (
                <Segmented<RelayTransport>
                  label={t('relay.transport')}
                  value={transport}
                  onChange={setTransport}
                  options={info.transports.map((tr) => ({ value: tr, label: tr === 'ntfy' ? 'ntfy' : 'Expo push' }))}
                  testID="relay-transport"
                />
              ) : null}
              <T variant="caption">{transport === 'ntfy' ? t('relay.ntfyHint') : t('relay.expoHint')}</T>
            </View>
          ) : null}
          {notice}
          {info ? (
            <Button label={t('relay.pair')} onPress={() => void pair()} busy={busy} disabled={code.trim() === '' || info.transports.length === 0} testID="relay-pair" />
          ) : (
            <Button label={t('relay.check')} onPress={() => void check()} busy={busy} disabled={url.trim() === ''} testID="relay-check" />
          )}
        </Card>
        <T variant="caption">{t('relay.fallback')}</T>
      </Screen>
    );
  }

  const appOrigins = new Set(panels.map((p) => p.origin));
  return (
    <Screen title={t('relay.title')} onBack={nav.pop} testID="screen-relay">
      <Card>
        <KeyValue label={t('relay.url')} value={entry.url} />
        {view ? <KeyValue label={t('relay.version')} value={view.relay.version} /> : null}
        <KeyValue label={t('relay.transport')} value={entry.transport === 'ntfy' ? 'ntfy' : 'Expo push'} />
        {view?.device.disabled ? <Badge label={t('relay.disabled')} tone="warning" testID="relay-disabled" /> : null}
        {entry.transport === 'ntfy' && entry.ntfyTopic ? (
          <View style={{ gap: theme.space(2) }}>
            <KeyValue label={t('relay.topic')} value={entry.ntfyTopic} testID="relay-topic" />
            <T variant="caption">{t('relay.ntfySubscribe', { server: entry.ntfyUrl ?? '' })}</T>
            {entry.ntfyUrl ? (
              <Button
                label={t('relay.openNtfy')}
                kind="secondary"
                compact
                onPress={() => void Linking.openURL(ntfySubscribeLink(entry.ntfyUrl as string, entry.ntfyTopic as string)).catch(() => undefined)}
                testID="relay-open-ntfy"
              />
            ) : null}
          </View>
        ) : null}
      </Card>
      {notice}
      {view ? (
        view.panels.map((p) => (
          <Section key={p.id} title={p.name}>
            <Card>
              <T variant="caption">
                {p.origin}
                {appOrigins.has(p.origin) ? '' : ` · ${t('relay.notInApp')}`}
                {p.lastError ? ` · ${t('relay.panelError', { error: p.lastError })}` : ''}
              </T>
              {RELAY_EVENTS.filter((e) => e !== 'nodes' || p.nodes).map((event) => (
                <ToggleRow key={event} label={t(EVENT_LABEL[event])} value={(choices[p.id] ?? []).includes(event)} onChange={(on) => toggle(p.id, event, on)} testID={`relay-${p.id}-${event}`} />
              ))}
              {p.realtime ? <T variant="caption">{t('relay.realtime')}</T> : null}
            </Card>
          </Section>
        ))
      ) : (
        <Loading />
      )}
      {view && view.panels.length === 0 ? <Notice tone="info">{t('relay.noPanels')}</Notice> : null}
      <Button label={t('relay.save')} onPress={() => void save()} busy={busy} disabled={!view} testID="relay-save" />
      <Button label={t('relay.test')} kind="secondary" onPress={() => void test()} disabled={busy} testID="relay-test" />
      <Button label={t('relay.unregister')} kind="danger" onPress={() => setConfirm(true)} disabled={busy} testID="relay-unregister" />
      <T variant="caption">{t('relay.fallback')}</T>
      <ConfirmDialog
        visible={confirm}
        title={t('relay.unregister')}
        body={t('relay.unregisterBody')}
        confirmLabel={t('relay.unregister')}
        onConfirm={() => void unregister()}
        onCancel={() => setConfirm(false)}
        busy={busy}
      />
    </Screen>
  );
}
