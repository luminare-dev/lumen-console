// Where keys and daemon tokens live. Native: the platform keychain/keystore through
// expo-secure-store, readable after the first unlock so the background check can use them. Web:
// sessionStorage only, so a key disappears with the browser tab, and the app says so. Secrets
// never go into AsyncStorage.

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export interface SecretStore {
  /** False on the web: the key is gone after the session and must be entered again. */
  readonly persistent: boolean;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The secret names of a panel: its client key, its application key and one token per node. */
export const secretName = {
  client: (panelId: string) => `client.${panelId}`,
  application: (panelId: string) => `app.${panelId}`,
  daemon: (panelId: string, nodeId: number) => `wings.${panelId}.${nodeId}`,
};

// expo-secure-store accepts [A-Za-z0-9._-] in key names.
const keyName = (name: string) => `console.${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;

export function createSecureSecretStore(store: typeof SecureStore = SecureStore): SecretStore {
  const options: SecureStore.SecureStoreOptions = { keychainAccessible: store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  return {
    persistent: true,
    get: (name) => store.getItemAsync(keyName(name), options),
    set: (name, value) => store.setItemAsync(keyName(name), value, options),
    remove: (name) => store.deleteItemAsync(keyName(name), options),
  };
}

/** A session-only store over the Web Storage interface (sessionStorage in the browser). */
export function createSessionSecretStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): SecretStore {
  const memory = new Map<string, string>();
  return {
    persistent: false,
    async get(name) {
      try {
        return storage?.getItem(keyName(name)) ?? memory.get(name) ?? null;
      } catch {
        return memory.get(name) ?? null;
      }
    },
    async set(name, value) {
      memory.set(name, value);
      try {
        storage?.setItem(keyName(name), value);
      } catch {
        // Storage blocked: the in-memory copy lasts until the page is reloaded.
      }
    },
    async remove(name) {
      memory.delete(name);
      try {
        storage?.removeItem(keyName(name));
      } catch {
        // nothing stored
      }
    },
  };
}

/** An in-memory store for tests. */
export function createMemorySecretStore(): SecretStore {
  return createSessionSecretStore(null);
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export const secretStore: SecretStore =
  Platform.OS === 'web' ? createSessionSecretStore(browserSessionStorage()) : createSecureSecretStore();
