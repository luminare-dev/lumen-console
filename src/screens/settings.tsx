import { useState } from 'react';
import { Linking, View } from 'react-native';

import appConfig from '../../app.json';
import { backgroundSupported, setBackgroundChecks } from '../alerts/background';
import type { Thresholds } from '../alerts/evaluate';
import { panelAccountUrl } from '../api/url';
import { formatDateTime } from '../i18n';
import { useNav } from '../navigation';
import { twoFactorView } from '../state/account';
import { useApp } from '../state/AppProvider';
import type { LanguageSetting, ThemeSetting } from '../state/settings';
import { useResource } from '../state/useResource';
import { importTokens, PRESET_NAMES, PRESETS, type PresetName } from '../theme/tokens';
import { Badge, Button, Card, Disclosure, ErrorPanel, Field, KeyValue, ListRow, Loading, Notice, Screen, Section, Segmented, T, ToggleRow } from '../ui/kit';
import { NeedsKey } from './connect';

function NumberField({ label, value, onChange, testID }: { label: string; value: number; onChange: (n: number) => void; testID?: string }) {
  const [text, setText] = useState(String(value));
  return (
    <Field
      label={label}
      value={text}
      keyboard="number-pad"
      testID={testID}
      onChangeText={(next) => {
        setText(next);
        const n = Number(next);
        if (next.trim() !== '' && Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function SettingsScreen() {
  const { t, settings, updateSettings, panels, active } = useApp();
  const nav = useNav();
  const th = settings.thresholds;
  const setThreshold = (patch: Partial<Thresholds>) => updateSettings({ thresholds: { ...th, ...patch } });
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));
  const version = appConfig.expo.version;

  return (
    <Screen title={t('settings.title')} testID="screen-settings">
      <Section title={t('settings.panels')}>
        <ListRow title={active?.name ?? t('panels.add')} subtitle={t('settings.panelCount', { count: panels.length })} onPress={() => nav.push({ name: 'panels' })} testID="settings-panels" />
        {active ? <ListRow title={t('account.title')} subtitle={active.username} onPress={() => nav.push({ name: 'account' })} testID="settings-account" /> : null}
      </Section>

      <Section title={t('settings.language')}>
        <Segmented<LanguageSetting>
          label={t('settings.language')}
          value={settings.language}
          onChange={(language) => updateSettings({ language })}
          options={[
            { value: 'system', label: t('settings.languageSystem') },
            { value: 'en', label: 'English' },
            { value: 'de', label: 'Deutsch' },
          ]}
          testID="language"
        />
      </Section>

      <Section title={t('settings.theme')}>
        <Segmented<ThemeSetting>
          label={t('settings.theme')}
          value={settings.theme}
          onChange={(theme) => updateSettings({ theme })}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'dark', label: t('settings.themeDark') },
            { value: 'light', label: t('settings.themeLight') },
          ]}
          testID="theme"
        />
      </Section>

      <Section title={t('settings.tokens')}>
        <Segmented<PresetName>
          label={t('settings.preset')}
          value={settings.preset}
          onChange={(preset) => updateSettings({ preset })}
          options={PRESET_NAMES.map((name) => ({ value: name, label: PRESETS[name].meta.name }))}
          testID="preset"
        />
        <Button label={t('settings.importTokens')} kind="secondary" onPress={() => nav.push({ name: 'tokens' })} testID="tokens-import" />
        {settings.customTokens ? <Button label={t('settings.resetTokens')} kind="ghost" onPress={() => updateSettings({ customTokens: null })} testID="tokens-reset" /> : null}
      </Section>

      <Section title={t('settings.thresholds')}>
        <Card>
          <NumberField label={t('settings.diskPercent')} value={th.diskPercent} onChange={(n) => setThreshold({ diskPercent: clamp(n, 50, 99) })} testID="threshold-disk" />
          <NumberField label={t('settings.memoryPercent')} value={th.memoryPercent} onChange={(n) => setThreshold({ memoryPercent: clamp(n, 50, 100) })} />
          <NumberField label={t('settings.nodePercent')} value={th.nodePercent} onChange={(n) => setThreshold({ nodePercent: clamp(n, 50, 150) })} />
          {backgroundSupported ? (
            <ToggleRow
              label={t('settings.backgroundChecks')}
              value={settings.backgroundChecks}
              onChange={(backgroundChecks) => {
                updateSettings({ backgroundChecks });
                void setBackgroundChecks(backgroundChecks && panels.length > 0).catch(() => undefined);
              }}
            />
          ) : null}
          <T variant="caption">{t('settings.perPanelAlerts')}</T>
        </Card>
      </Section>

      <Section title={t('settings.about')}>
        <Card>
          <T variant="label">{t('app.name')}</T>
          <T variant="caption">{t('settings.version', { version })}</T>
          <T variant="caption">{t('settings.byline')}</T>
          <T variant="caption">{t('settings.source')}</T>
          <T variant="caption">{t('app.notAffiliated')}</T>
        </Card>
      </Section>
    </Screen>
  );
}

/** The key's account: 2FA (from the application API when there is a key) and its API keys. */
export function AccountScreen() {
  const { t, theme, client, admin, active, language } = useApp();
  const nav = useNav();
  const account = useResource(client, 'account', (c) => c.account());
  const keys = useResource(client, 'apiKeys', (c) => c.apiKeys());
  const id = account.data?.id;
  const asAdmin = useResource(admin && id !== undefined ? admin : null, `user:${id}`, (a) => a.user(id as number));
  const a = account.data;
  const twoFactor = twoFactorView({ hasAppKey: admin !== null, value: asAdmin.data?.['2fa'], error: asAdmin.error });
  return (
    <Screen title={t('account.title')} onBack={nav.pop} testID="screen-account">
      {!client ? <NeedsKey /> : null}
      {account.error ? <ErrorPanel error={account.error} onRetry={account.reload} /> : null}
      {!a && !account.error && client ? <Loading /> : null}
      {a ? (
        <Card>
          <KeyValue label={t('admin.username')} value={a.username} />
          <KeyValue label={t('admin.email')} value={a.email} />
          <KeyValue label={t('admin.name')} value={`${a.first_name} ${a.last_name}`} />
          <KeyValue label={t('admin.role')} value={a.admin ? t('admin.rootAdmin') : t('admin.user')} />
          <KeyValue
            label={t('account.twoFactor')}
            value={
              twoFactor.state === 'on' || twoFactor.state === 'off' ? (
                <Badge label={twoFactor.state === 'on' ? t('account.twoFactorOn') : t('account.twoFactorOff')} tone={twoFactor.state === 'on' ? 'success' : 'warning'} testID="account-2fa" />
              ) : (
                <Badge label={twoFactor.state === 'loading' ? t('common.loading') : t('account.twoFactorHiddenBadge')} testID="account-2fa" />
              )
            }
          />
          {twoFactor.state === 'hidden' ? (
            <View style={{ gap: theme.space(2) }} testID="account-2fa-help">
              <T variant="muted">{t('account.twoFactorHidden')}</T>
              {active ? (
                <Button label={t('account.openPanel')} kind="secondary" compact onPress={() => void Linking.openURL(panelAccountUrl(active.origin)).catch(() => undefined)} testID="account-open-panel" />
              ) : null}
              <Disclosure label={t('account.why')} testID="account-2fa-why">
                {twoFactor.reason === 'noAppKey' ? t('account.twoFactorWhyNoKey') : t('account.twoFactorWhyKeyCannotRead')}
              </Disclosure>
            </View>
          ) : null}
        </Card>
      ) : null}
      <Section title={t('account.apiKeys')}>
        {keys.error ? <ErrorPanel error={keys.error} onRetry={keys.reload} /> : null}
        {(keys.data ?? []).map((key) => (
          <ListRow
            key={key.identifier}
            title={key.description || key.identifier}
            subtitle={`${key.identifier} · ${key.last_used_at ? t('account.lastUsed', { date: formatDateTime(key.last_used_at, language) }) : t('account.neverUsed')}${key.allowed_ips.length ? ` · ${key.allowed_ips.join(', ')}` : ''}`}
            testID={`api-key-${key.identifier}`}
          />
        ))}
        <T variant="caption">{t('account.apiKeysNote')}</T>
      </Section>
      <Notice tone="info">{t('account.webOnly')}</Notice>
    </Screen>
  );
}

export function TokensScreen() {
  const { t, settings, updateSettings } = useApp();
  const nav = useNav();
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string }>();

  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setMessage({ tone: 'danger', text: t('tokens.invalidJson') });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setMessage({ tone: 'danger', text: t('tokens.invalidJson') });
      return;
    }
    const result = importTokens(parsed, settings.preset);
    updateSettings({ customTokens: result.tokens });
    const parts = [result.replaced.length > 0 ? t('tokens.replaced', { fields: result.replaced.join(', ') }) : t('tokens.applied')];
    if (result.lowContrast > 0) parts.push(t('tokens.contrast', { count: result.lowContrast }));
    setMessage({ tone: result.replaced.length > 0 || result.lowContrast > 0 ? 'warning' : 'success', text: parts.join(' ') });
  };

  return (
    <Screen title={t('tokens.title')} onBack={nav.pop} testID="screen-tokens">
      <T variant="muted">{t('tokens.hint')}</T>
      <Field label="JSON" value={text} onChangeText={setText} multiline testID="tokens-json" />
      {message ? (
        <Notice tone={message.tone} testID="tokens-result">
          {message.text}
        </Notice>
      ) : null}
      <Button label={t('tokens.apply')} onPress={apply} disabled={text.trim() === ''} testID="tokens-apply" />
    </Screen>
  );
}
