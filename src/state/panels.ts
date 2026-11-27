// The list of panels (name, address, flavour and per-panel alert settings; no secrets) and the
// operations on it. The list is kept in the key-value store; the keys sit in the SecretStore.

import { ApplicationApi } from '../api/application';
import { ClientApi } from '../api/client';
import { classifyFetchError, PanelError } from '../api/errors';
import type { FetchLike } from '../api/http';
import { checkKeyFormat } from '../api/keys';
import { detectFlavor, type Flavor } from '../api/panel';
import { hostOf, normalizePanelUrl } from '../api/url';
import { secretName, type SecretStore } from './secrets';

export interface PanelAlertSettings {
  /** Background and manual checks include this panel. */
  enabled: boolean;
  /** A server that was running is offline now (stopped or crashed). */
  offline: boolean;
  /** Disk and memory of each server against the thresholds. */
  resources: boolean;
  /** The latest backup of a server failed. */
  backups: boolean;
  /** Nodes unreachable or allocated past the threshold (application key only). */
  nodes: boolean;
}

export const DEFAULT_PANEL_ALERTS: PanelAlertSettings = { enabled: true, offline: true, resources: true, backups: true, nodes: true };

export interface PanelEntry {
  id: string;
  name: string;
  /** https://host[:port] */
  origin: string;
  flavor: Flavor;
  version?: string;
  /** The account of the client key. */
  username: string;
  /** The account is a root admin of the panel. */
  rootAdmin: boolean;
  hasApplicationKey: boolean;
  /** Nodes with a daemon token saved for this panel. */
  tokenNodes: number[];
  alerts: PanelAlertSettings;
  addedAt: string;
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const PANELS_KEY = 'console.panels.v1';
export const ACTIVE_KEY = 'console.activePanel.v1';

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

function sanitizeEntry(value: unknown): PanelEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.origin !== 'string' || typeof v.addedAt !== 'string') return null;
  const a = typeof v.alerts === 'object' && v.alerts !== null ? (v.alerts as Record<string, unknown>) : {};
  return {
    id: v.id,
    name: v.name,
    origin: v.origin,
    flavor: v.flavor === 'hydrodactyl' ? 'hydrodactyl' : 'pterodactyl',
    version: typeof v.version === 'string' ? v.version : undefined,
    username: typeof v.username === 'string' ? v.username : '',
    rootAdmin: v.rootAdmin === true,
    hasApplicationKey: v.hasApplicationKey === true,
    tokenNodes: Array.isArray(v.tokenNodes) ? v.tokenNodes.filter((n): n is number => Number.isInteger(n)) : [],
    alerts: {
      enabled: bool(a.enabled, DEFAULT_PANEL_ALERTS.enabled),
      offline: bool(a.offline, DEFAULT_PANEL_ALERTS.offline),
      resources: bool(a.resources, DEFAULT_PANEL_ALERTS.resources),
      backups: bool(a.backups, DEFAULT_PANEL_ALERTS.backups),
      nodes: bool(a.nodes, DEFAULT_PANEL_ALERTS.nodes),
    },
    addedAt: v.addedAt,
  };
}

export async function loadPanels(store: KeyValueStore): Promise<PanelEntry[]> {
  const raw = await store.getItem(PANELS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(sanitizeEntry).filter((e): e is PanelEntry => e !== null) : [];
  } catch {
    return [];
  }
}

export async function savePanels(store: KeyValueStore, panels: PanelEntry[]): Promise<void> {
  await store.setItem(PANELS_KEY, JSON.stringify(panels));
}

export function newPanelId(now: Date = new Date(), random: () => number = Math.random): string {
  return `${now.getTime().toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

export interface AddPanelInput {
  name: string;
  url: string;
  clientKey: string;
  /** Optional; admins only. */
  applicationKey?: string;
}

export interface PanelDeps {
  store: KeyValueStore;
  secrets: SecretStore;
  fetch?: FetchLike;
  now?: Date;
}

const withField = (error: unknown, field: 'client' | 'application'): PanelError => {
  const e = error instanceof PanelError ? error : classifyFetchError(error);
  e.field = field;
  return e;
};

/** Checks an application key against the panel; throws a PanelError with field "application". */
export async function checkApplicationKey(origin: string, key: string, fetchImpl?: FetchLike): Promise<string> {
  try {
    const trimmed = checkKeyFormat(key, 'application');
    await new ApplicationApi({ origin, key: trimmed, fetch: fetchImpl }).ping();
    return trimmed;
  } catch (error) {
    throw withField(error, 'application');
  }
}

/**
 * Checks the address and keys against the panel (GET /api/client/account, the flavour, and with
 * an application key one page of users) and only then saves the entry and the keys. Nothing is
 * saved when a check fails. Adding the same address again replaces the keys of that entry.
 */
export async function addPanel(input: AddPanelInput, deps: PanelDeps): Promise<{ entry: PanelEntry; panels: PanelEntry[] }> {
  const origin = normalizePanelUrl(input.url);
  let clientKey: string;
  let account;
  let flavor;
  try {
    clientKey = checkKeyFormat(input.clientKey, 'client');
    const api = new ClientApi({ origin, key: clientKey, fetch: deps.fetch });
    account = await api.account();
    flavor = await detectFlavor(api);
  } catch (error) {
    throw withField(error, 'client');
  }
  const applicationKey = input.applicationKey?.trim() ? await checkApplicationKey(origin, input.applicationKey, deps.fetch) : undefined;

  const panels = await loadPanels(deps.store);
  const existing = panels.find((p) => p.origin === origin);
  const entry: PanelEntry = {
    id: existing?.id ?? newPanelId(deps.now),
    name: input.name.trim() || existing?.name || hostOf(origin),
    origin,
    flavor: flavor.flavor,
    version: flavor.version,
    username: account.username,
    rootAdmin: account.admin,
    hasApplicationKey: applicationKey !== undefined || (existing?.hasApplicationKey ?? false),
    tokenNodes: existing?.tokenNodes ?? [],
    alerts: existing?.alerts ?? DEFAULT_PANEL_ALERTS,
    addedAt: existing?.addedAt ?? (deps.now ?? new Date()).toISOString(),
  };
  const next = existing ? panels.map((p) => (p.id === entry.id ? entry : p)) : [...panels, entry];
  await deps.secrets.set(secretName.client(entry.id), clientKey);
  if (applicationKey) await deps.secrets.set(secretName.application(entry.id), applicationKey);
  await savePanels(deps.store, next);
  return { entry, panels: next };
}

export async function updatePanel(id: string, patch: Partial<Pick<PanelEntry, 'name' | 'alerts' | 'hasApplicationKey' | 'tokenNodes'>>, store: KeyValueStore): Promise<PanelEntry[]> {
  const next = (await loadPanels(store)).map((p) => (p.id === id ? { ...p, ...patch } : p));
  await savePanels(store, next);
  return next;
}

/** Saves (after checking) or removes the application key of a panel. */
export async function setApplicationKey(entry: PanelEntry, key: string | null, deps: PanelDeps): Promise<PanelEntry[]> {
  if (key === null || key.trim() === '') {
    await deps.secrets.remove(secretName.application(entry.id));
    return updatePanel(entry.id, { hasApplicationKey: false }, deps.store);
  }
  const checked = await checkApplicationKey(entry.origin, key, deps.fetch);
  await deps.secrets.set(secretName.application(entry.id), checked);
  return updatePanel(entry.id, { hasApplicationKey: true }, deps.store);
}

/** Saves or removes the daemon token of one node (used only for that node's Wings API). */
export async function setDaemonToken(entry: PanelEntry, nodeId: number, token: string | null, deps: { store: KeyValueStore; secrets: SecretStore }): Promise<PanelEntry[]> {
  const others = entry.tokenNodes.filter((n) => n !== nodeId);
  if (token === null || token.trim() === '') {
    await deps.secrets.remove(secretName.daemon(entry.id, nodeId));
    return updatePanel(entry.id, { tokenNodes: others }, deps.store);
  }
  await deps.secrets.set(secretName.daemon(entry.id, nodeId), token.trim());
  return updatePanel(entry.id, { tokenNodes: [...others, nodeId] }, deps.store);
}

export async function removePanel(id: string, deps: { store: KeyValueStore; secrets: SecretStore }): Promise<PanelEntry[]> {
  const all = await loadPanels(deps.store);
  const panels = all.filter((p) => p.id !== id);
  await deps.secrets.remove(secretName.client(id));
  await deps.secrets.remove(secretName.application(id));
  for (const node of all.find((p) => p.id === id)?.tokenNodes ?? []) await deps.secrets.remove(secretName.daemon(id, node));
  await savePanels(deps.store, panels);
  return panels;
}

export interface PanelApis {
  client: ClientApi | null;
  admin: ApplicationApi | null;
}

/** The API clients for a saved panel; null where the key is missing (web, after the session). */
export async function apisFor(entry: PanelEntry, secrets: SecretStore, fetchImpl?: FetchLike): Promise<PanelApis> {
  const [clientKey, appKey] = await Promise.all([secrets.get(secretName.client(entry.id)), entry.hasApplicationKey ? secrets.get(secretName.application(entry.id)) : null]);
  return {
    client: clientKey ? new ClientApi({ origin: entry.origin, key: clientKey, fetch: fetchImpl }) : null,
    admin: appKey ? new ApplicationApi({ origin: entry.origin, key: appKey, fetch: fetchImpl }) : null,
  };
}
