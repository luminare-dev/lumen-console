import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { backgroundSupported, INTERVAL_MINUTES } from '../alerts/background';
import { checkAllPanels, loadLastCheck, type CheckResult } from '../alerts/check';
import { alertMessage } from '../alerts/messages';
import { formatDateTime } from '../i18n';
import { useApp } from '../state/AppProvider';
import { Button, Card, ListRow, Notice, Screen, Section, T } from '../ui/kit';

export function AlertsScreen() {
  const { t, language, settings, panels, theme, store, secrets } = useApp();
  const [last, setLast] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const { result } = await checkAllPanels({ store, secrets, thresholds: settings.thresholds });
      setLast(result);
    } finally {
      setBusy(false);
    }
  }, [settings.thresholds, store, secrets]);

  useEffect(() => {
    let cancelled = false;
    void loadLastCheck(store).then((stored) => {
      if (cancelled) return;
      setLast(stored);
      // A fresh check whenever the screen opens; the stored one shows meanwhile.
      if (panels.length > 0) void check();
    });
    return () => {
      cancelled = true;
    };
  }, [check, panels.length, store]);

  const all = (last?.results ?? []).flatMap((r) => r.alerts.map((alert) => ({ panel: r.panel.name, alert })));
  const failed = (last?.results ?? []).filter((r) => r.error || r.noKey);

  return (
    <Screen title={t('alerts.title')} testID="screen-alerts">
      <T variant="caption" testID="alerts-last-check">
        {last ? t('alerts.lastCheck', { date: formatDateTime(last.checkedAt, language) }) : t('alerts.never')}
      </T>
      {failed.map((r) => (
        <Notice key={r.panel.id} tone="danger">
          {t('alerts.unreachable', { name: r.panel.name, reason: r.noKey ? t('panels.needsKey') : t(`error.${r.error ?? 'network'}`) })}
        </Notice>
      ))}
      {last && all.length === 0 && failed.length === 0 ? (
        <Notice tone="success" testID="alerts-none">
          {t('alerts.none')}
        </Notice>
      ) : null}
      <View style={{ gap: theme.space(2) }} testID="alerts-list">
        {all.map(({ panel, alert }) => (
          <ListRow
            key={`${panel}-${alert.id}`}
            title={alertMessage(alert, panel, t)}
            titleLines={3}
            right={<View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: alert.severity === 'critical' ? theme.color.danger : theme.color.warning }} aria-label={alert.severity} />}
            testID={`alert-${alert.kind}`}
          />
        ))}
      </View>
      <Button label={t('alerts.checkNow')} onPress={() => void check()} busy={busy} kind="secondary" testID="alerts-check" />
      <Section title={t('alerts.background')}>
        <Card>
          <T variant="muted">{backgroundSupported ? t('alerts.backgroundOn', { minutes: INTERVAL_MINUTES }) : t('alerts.backgroundWeb')}</T>
          {backgroundSupported ? <T variant="caption">{t('alerts.platformLimit')}</T> : null}
          <T variant="caption">{t('alerts.relayNote')}</T>
        </Card>
      </Section>
    </Screen>
  );
}
