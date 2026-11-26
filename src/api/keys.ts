import { PanelError } from './errors';

export type KeyKind = 'client' | 'application';

/**
 * Checks the shape of a key before it is sent anywhere. Pterodactyl prefixes client keys with
 * "ptlc_" and application keys with "ptla_"; Hydrodactyl uses "hydro_" for both, and keys from
 * before Pterodactyl 1.4 have no prefix. Only a clearly wrong prefix is refused here; the panel
 * decides the rest.
 */
export function checkKeyFormat(key: string, kind: KeyKind): string {
  const trimmed = key.trim();
  if (trimmed === '') throw new PanelError('unauthorized', 'empty API key');
  if (/\s/.test(trimmed)) throw new PanelError('unauthorized', 'the key contains spaces');
  if (kind === 'client' && trimmed.startsWith('ptla_')) throw new PanelError('wrongKeyType', 'an application key (ptla_) in the client key field');
  if (kind === 'application' && trimmed.startsWith('ptlc_')) throw new PanelError('wrongKeyType', 'a client key (ptlc_) in the application key field');
  return trimmed;
}
