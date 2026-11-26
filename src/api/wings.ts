// Node health straight from the Wings daemon. Wings has no public status endpoint: everything
// below /api needs the node's daemon token, which the panel never hands to a client. The app
// therefore uses the token only when an admin enters it for that node (stored like an API key).
// Without a token it still learns whether the daemon answers: an unauthenticated request to
// /api/system gets 401 from a running Wings.

import { classifyFetchError, kindForStatus, PanelError } from './errors';
import type { FetchLike } from './http';
import type { WingsSystem } from './types';

export type ProbeResult =
  | { state: 'online'; system?: WingsSystem }
  | { state: 'tokenRejected' }
  | { state: 'unreachable'; reason: PanelError['kind'] };

export async function probeNode(
  origin: string,
  options: { token?: string; fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const fetchImpl = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/system?v=2`, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
  } catch (error) {
    return { state: 'unreachable', reason: classifyFetchError(error).kind };
  } finally {
    clearTimeout(timer);
  }
  if (!options.token) {
    // 401 with "WWW-Authenticate: Bearer" is a running Wings asking for its token.
    return response.status === 401 ? { state: 'online' } : { state: 'unreachable', reason: kindForStatus(response.status) };
  }
  if (response.status === 401 || response.status === 403) return { state: 'tokenRejected' };
  if (!response.ok) return { state: 'unreachable', reason: kindForStatus(response.status) };
  try {
    return { state: 'online', system: JSON.parse(await response.text()) as WingsSystem };
  } catch {
    return { state: 'online' };
  }
}
