// Panel flavour detection. Hydrodactyl answers GET /api/client/version; Pterodactyl has no such
// route and answers 404. The flavour decides the per-server paths (daemon type) and which extra
// endpoints the app may call.

import type { ClientApi } from './client';
import { PanelError } from './errors';

export type Flavor = 'pterodactyl' | 'hydrodactyl';

export interface PanelFlavor {
  flavor: Flavor;
  /** Hydrodactyl's reported version ("canary" builds report what their config says). */
  version?: string;
}

export async function detectFlavor(api: ClientApi): Promise<PanelFlavor> {
  try {
    const version = await api.version();
    return { flavor: 'hydrodactyl', version: version || undefined };
  } catch (error) {
    if (error instanceof PanelError && (error.kind === 'notFound' || error.kind === 'invalidResponse')) return { flavor: 'pterodactyl' };
    throw error;
  }
}
