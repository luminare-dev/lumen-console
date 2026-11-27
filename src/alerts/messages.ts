import type { Translate } from '../i18n';
import type { Alert } from './evaluate';

/** The sentence for one alert on one panel. */
export function alertMessage(alert: Alert, panelName: string, t: Translate): string {
  const params = { ...alert.params, panel: panelName };
  switch (alert.kind) {
    case 'serverStopped':
      return t('alerts.serverStopped', params);
    case 'serverUnreachable':
      return t('alerts.serverUnreachable', params);
    case 'disk':
      return t('alerts.disk', params);
    case 'memory':
      return t('alerts.memory', params);
    case 'backup':
      return t('alerts.backup', params);
    case 'nodeDown':
      return t('alerts.nodeDown', params);
    case 'nodeAllocated':
      return t(alert.params.what === 'disk' ? 'alerts.nodeDisk' : 'alerts.nodeMemory', params);
  }
}
