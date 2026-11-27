// One context for the app: settings, theme, translator, the panel list and the API clients for
// the active panel. Screens read it with useApp().

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

import { backgroundSupported, setBackgroundChecks } from '../alerts/background';
import type { ApplicationApi } from '../api/application';
import type { ClientApi } from '../api/client';
import { pickLanguage, translator, type Language, type Translate } from '../i18n';
import { resolveTokens, themeFor, type Theme } from '../theme/tokens';
import {
  ACTIVE_KEY,
  addPanel as addPanelTo,
  apisFor,
  loadPanels,
  removePanel as removePanelFrom,
  setApplicationKey as setApplicationKeyOf,
  setDaemonToken as setDaemonTokenOf,
  updatePanel as updatePanelIn,
  type AddPanelInput,
  type KeyValueStore,
  type PanelEntry,
} from './panels';
import { secretName, secretStore, type SecretStore } from './secrets';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';

export interface AppState {
  ready: boolean;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): void;
  language: Language;
  t: Translate;
  theme: Theme;
  panels: PanelEntry[];
  active: PanelEntry | null;
  /** Null while there is no panel, or its client key is missing (web, new session). */
  client: ClientApi | null;
  /** Null without an application key. */
  admin: ApplicationApi | null;
  secrets: SecretStore;
  store: KeyValueStore;
  secretsPersistent: boolean;
  selectPanel(id: string): void;
  addPanel(input: AddPanelInput): Promise<PanelEntry>;
  removePanel(id: string): Promise<void>;
  updatePanel(id: string, patch: Partial<Pick<PanelEntry, 'name' | 'alerts'>>): Promise<void>;
  setApplicationKey(id: string, key: string | null): Promise<void>;
  setDaemonToken(nodeId: number, token: string | null): Promise<void>;
  daemonToken(nodeId: number): Promise<string | null>;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp outside AppProvider');
  return value;
}

export interface AppProviderProps {
  children: ReactNode;
  store?: KeyValueStore;
  secrets?: SecretStore;
}

export function AppProvider({ children, store = AsyncStorage, secrets = secretStore }: AppProviderProps) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [panels, setPanels] = useState<PanelEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [apis, setApis] = useState<{ client: ClientApi | null; admin: ApplicationApi | null }>({ client: null, admin: null });
  const scheme = useColorScheme();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [loadedSettings, loadedPanels, storedActive] = await Promise.all([
        loadSettings(store).catch(() => DEFAULT_SETTINGS),
        loadPanels(store).catch(() => []),
        store.getItem(ACTIVE_KEY).catch(() => null),
      ]);
      if (cancelled) return;
      setSettings(loadedSettings);
      setPanels(loadedPanels);
      setActiveId(loadedPanels.some((p) => p.id === storedActive) ? storedActive : (loadedPanels[0]?.id ?? null));
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  // The background check is registered once a panel exists (and the setting is on).
  const hasPanels = panels.length > 0;
  useEffect(() => {
    if (!ready || !backgroundSupported) return;
    void setBackgroundChecks(settings.backgroundChecks && hasPanels).catch(() => undefined);
  }, [ready, hasPanels, settings.backgroundChecks]);

  const active = useMemo(() => panels.find((p) => p.id === activeId) ?? null, [panels, activeId]);
  const activeKey = active ? `${active.id}|${active.origin}|${active.hasApplicationKey}` : '';

  useEffect(() => {
    let cancelled = false;
    setApis({ client: null, admin: null });
    if (!active) return undefined;
    void apisFor(active, secrets)
      .then((next) => {
        if (!cancelled) setApis(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Only a change of panel, address or key presence needs new clients.
  }, [activeKey, secrets]);

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((current) => {
        const next = { ...current, ...patch };
        void saveSettings(store, next).catch(() => undefined);
        return next;
      });
    },
    [store]
  );

  const selectPanel = useCallback(
    (id: string) => {
      setActiveId(id);
      void store.setItem(ACTIVE_KEY, id).catch(() => undefined);
    },
    [store]
  );

  const addPanel = useCallback(
    async (input: AddPanelInput) => {
      const { entry, panels: next } = await addPanelTo(input, { store, secrets });
      setPanels(next);
      selectPanel(entry.id);
      return entry;
    },
    [store, secrets, selectPanel]
  );

  const removePanel = useCallback(
    async (id: string) => {
      const next = await removePanelFrom(id, { store, secrets });
      setPanels(next);
      if (activeId === id) {
        const fallback = next[0]?.id ?? null;
        setActiveId(fallback);
        if (fallback) void store.setItem(ACTIVE_KEY, fallback).catch(() => undefined);
        else void store.removeItem(ACTIVE_KEY).catch(() => undefined);
      }
    },
    [store, secrets, activeId]
  );

  const updatePanel = useCallback(
    async (id: string, patch: Partial<Pick<PanelEntry, 'name' | 'alerts'>>) => {
      setPanels(await updatePanelIn(id, patch, store));
    },
    [store]
  );

  const setApplicationKey = useCallback(
    async (id: string, key: string | null) => {
      const entry = panels.find((p) => p.id === id);
      if (!entry) return;
      setPanels(await setApplicationKeyOf(entry, key, { store, secrets }));
    },
    [panels, store, secrets]
  );

  const setDaemonToken = useCallback(
    async (nodeId: number, token: string | null) => {
      if (!active) return;
      setPanels(await setDaemonTokenOf(active, nodeId, token, { store, secrets }));
    },
    [active, store, secrets]
  );

  const daemonToken = useCallback(
    async (nodeId: number) => (active && active.tokenNodes.includes(nodeId) ? secrets.get(secretName.daemon(active.id, nodeId)) : null),
    [active, secrets]
  );

  const language: Language = settings.language === 'system' ? pickLanguage(getLocales().map((l) => l.languageCode)) : settings.language;
  const t = useMemo(() => translator(language), [language]);
  const tokens = useMemo(() => resolveTokens(settings.preset, settings.customTokens), [settings.preset, settings.customTokens]);
  const mode = settings.theme === 'system' ? (scheme === 'light' ? 'light' : 'dark') : settings.theme;
  const theme = useMemo(() => themeFor(tokens, mode), [tokens, mode]);

  const value: AppState = {
    ready,
    settings,
    updateSettings,
    language,
    t,
    theme,
    panels,
    active,
    client: apis.client,
    admin: apis.admin,
    secrets,
    store,
    secretsPersistent: secrets.persistent,
    selectPanel,
    addPanel,
    removePanel,
    updatePanel,
    setApplicationKey,
    setDaemonToken,
    daemonToken,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
