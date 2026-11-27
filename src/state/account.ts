// What the account screen says about 2FA. The Client API reports it only through
// GET /account/two-factor, which creates a new TOTP setup secret on every call, so the app never
// asks it; the status comes from the Application API (the user's "2fa") or is not shown.

import type { PanelError } from '../api/errors';

export type TwoFactorView =
  | { state: 'on' | 'off' | 'loading' }
  /** Not shown: no application key, or the key may not read the user. */
  | { state: 'hidden'; reason: 'noAppKey' | 'appKeyCannotRead'; error?: PanelError };

export function twoFactorView(input: { hasAppKey: boolean; value: boolean | undefined; error: PanelError | undefined }): TwoFactorView {
  if (!input.hasAppKey) return { state: 'hidden', reason: 'noAppKey' };
  if (input.value !== undefined) return { state: input.value ? 'on' : 'off' };
  if (input.error) return { state: 'hidden', reason: 'appKeyCannotRead', error: input.error };
  return { state: 'loading' };
}
