// An in-memory stand-in for a panel (Client and Application API), its nodes' Wings endpoints and
// the console WebSocket, for the unit tests (through `fetch` and `socketFactory`) and the e2e run
// (Playwright answers the app's requests with `handle` and its sockets with `openConsole`). It
// keeps the panel's envelopes, status codes and error bodies. It is test code: it never talks to
// a network.

import type { SocketFactory, SocketLike } from '../api/console';
import type { FetchLike } from '../api/http';
import type { Flavor } from '../api/panel';
import type { Backup, PanelUser, PowerSignal } from '../api/types';
import {
  createFixtures,
  MOCK_APP_KEY,
  MOCK_CLIENT_KEY,
  MOCK_DAEMON_TOKEN,
  MOCK_DOWN_NODE_ORIGIN,
  MOCK_HYDRO_APP_KEY,
  MOCK_HYDRO_CLIENT_KEY,
  MOCK_HYDRO_ORIGIN,
  MOCK_HYDRO_VERSION,
  MOCK_NODE_ORIGIN,
  MOCK_ORIGIN,
  type MockData,
  type MockServer,
} from './fixtures';

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MockOptions {
  flavor?: Flavor;
  now?: Date;
}

/** One console connection as the node sees it. */
export interface ConsoleEndpoint {
  receive(text: string): void;
  close(): void;
}

export interface MockPanel {
  flavor: Flavor;
  origin: string;
  clientKey: string;
  appKey: string;
  data: MockData;
  /** Every request seen, oldest first ("METHOD /path?query", host-relative for the panel). */
  log: string[];
  /** Console commands the node received, per server identifier. */
  commands: Record<string, string[]>;
  uploads: { directory: string; name: string }[];
  /** Answers the next n panel requests with this status. */
  failNext(status: number, count?: number): void;
  /** null means the host does not answer (network error). */
  handle(request: MockRequest): MockResponse | null;
  fetch: FetchLike;
  /** True when a console socket URL belongs to one of this panel's servers. */
  ownsSocket(url: string): boolean;
  /** Opens a console connection for a socket URL; `send` gets every frame the node sends. */
  openConsole(url: string, send: (text: string) => void, close: (code: number) => void): ConsoleEndpoint;
  socketFactory: SocketFactory;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Max-Age': '600',
};

const CODES: Record<number, string> = {
  400: 'BadRequestHttpException',
  401: 'AuthenticationException',
  403: 'AccessDeniedHttpException',
  404: 'NotFoundHttpException',
  409: 'ConflictHttpException',
  422: 'ValidationException',
  500: 'HttpException',
  502: 'DaemonConnectionException',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const json = (status: number, value: unknown): MockResponse => ({
  status,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: value === undefined ? '' : JSON.stringify(value),
});

const errorBody = (status: number, detail: string) => json(status, { errors: [{ code: CODES[status] ?? 'HttpException', status: String(status), detail }] });

const item = (object: string, attributes: unknown) => ({ object, attributes });

function list(object: string, items: unknown[], query: URLSearchParams) {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 50) || 50));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return {
    object: 'list',
    data: slice.map((attributes) => item(object, attributes)),
    meta: {
      pagination: {
        total: items.length,
        count: slice.length,
        per_page: perPage,
        current_page: page,
        total_pages: Math.max(1, Math.ceil(items.length / perPage)),
      },
    },
  };
}

function parseBody(body: string | null | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new HttpError(400, 'The request body is not valid JSON.');
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const MiB = 1024 * 1024;

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function createMockPanel(options: MockOptions = {}): MockPanel {
  const flavor: Flavor = options.flavor ?? 'pterodactyl';
  const hydro = flavor === 'hydrodactyl';
  const origin = hydro ? MOCK_HYDRO_ORIGIN : MOCK_ORIGIN;
  const clientKey = hydro ? MOCK_HYDRO_CLIENT_KEY : MOCK_CLIENT_KEY;
  const appKey = hydro ? MOCK_HYDRO_APP_KEY : MOCK_APP_KEY;
  const now = options.now ?? new Date();
  const data = createFixtures(now);
  if (hydro) {
    for (const node of data.nodes) node.daemon_type = 'wings';
    // Other uuids than the Pterodactyl mock, so one test can run both behind the same node.
    for (const server of data.servers) server.uuid = `e${server.uuid.slice(1)}`;
  }
  const log: string[] = [];
  const failures: number[] = [];
  const commands: Record<string, string[]> = {};
  const uploads: { directory: string; name: string }[] = [];
  const consoles = new Map<string, Set<(event: string, args: string[]) => void>>();
  let tokenCounter = 0;
  const validTokens = new Map<string, string>();
  let nextBackup = 3;

  const account = () => data.users.find((u) => u.id === data.accountId) as PanelUser;
  const nodeOf = (server: MockServer) => data.nodes.find((n) => n.id === server.node);
  const nodeOrigin = (server: MockServer) => (server.node === 1 ? MOCK_NODE_ORIGIN : MOCK_DOWN_NODE_ORIGIN);
  const canSee = (server: MockServer) => server.owner === data.accountId || server.subusers.includes(data.accountId);

  const broadcast = (server: MockServer, event: string, args: string[]) => {
    for (const listener of consoles.get(server.identifier) ?? []) listener(event, args);
  };

  const stats = (server: MockServer) =>
    JSON.stringify({
      memory_bytes: server.usage.memory,
      memory_limit_bytes: server.limits.memory * MiB,
      cpu_absolute: server.usage.cpu,
      disk_bytes: server.usage.disk,
      network: { rx_bytes: server.usage.rx, tx_bytes: server.usage.tx },
      state: server.state,
      uptime: server.usage.uptime,
    });

  const setState = (server: MockServer, state: MockServer['state']) => {
    server.state = state;
    if (state === 'offline') server.usage = { ...server.usage, memory: 0, cpu: 0, uptime: 0 };
    if (state === 'running' && server.usage.memory === 0) server.usage = { ...server.usage, memory: 900 * MiB, cpu: 12.5, uptime: 1000 };
    broadcast(server, 'status', [state]);
    broadcast(server, 'stats', [stats(server)]);
  };

  function clientServer(server: MockServer) {
    const node = nodeOf(server);
    return {
      server_owner: server.owner === data.accountId,
      identifier: server.identifier,
      internal_id: server.id,
      uuid: server.uuid,
      name: server.name,
      node: node?.name ?? '',
      is_node_under_maintenance: node?.maintenance_mode ?? false,
      sftp_details: { ip: node?.fqdn ?? '', port: node?.daemon_sftp ?? 2022 },
      description: server.description,
      limits: { ...server.limits, threads: null, oom_disabled: true },
      invocation: server.startup,
      docker_image: server.image,
      egg_features: ['eula'],
      feature_limits: { databases: 2, allocations: 3, backups: 5 },
      status: server.status,
      is_suspended: server.status === 'suspended',
      is_installing: server.status === 'installing',
      is_transferring: false,
      ...(hydro ? { daemon_type: node?.daemon_type ?? 'wings' } : {}),
    };
  }

  function appServer(server: MockServer) {
    return {
      id: server.id,
      external_id: null,
      uuid: server.uuid,
      identifier: server.identifier,
      name: server.name,
      description: server.description,
      status: server.status,
      suspended: server.status === 'suspended',
      limits: { ...server.limits, threads: null, oom_disabled: true },
      feature_limits: { databases: 2, allocations: 3, backups: 5 },
      user: server.owner,
      node: server.node,
      allocation: server.allocations[0]?.id ?? 0,
      nest: server.nest,
      egg: server.egg,
      container: { startup_command: server.startup, image: server.image, installed: 1, environment: {} },
      created_at: new Date(now.getTime() - 86_400_000 * 40).toISOString(),
      updated_at: null,
    };
  }

  /** The node must answer for anything that goes through Wings. */
  const requireNode = (server: MockServer) => {
    if (server.node !== 1) throw new HttpError(502, 'An error was encountered while processing this request.');
  };

  function serverRoute(server: MockServer, method: string, rest: string[], query: URLSearchParams, body: string | null | undefined): MockResponse {
    const [area, a, b] = rest;
    if (server.status === 'suspended') throw new HttpError(409, 'This server is currently suspended and the functionality requested is unavailable.');

    if (method === 'GET' && area === 'websocket') {
      requireNode(server);
      tokenCounter += 1;
      const token = `mock-jwt-${flavor}-${server.identifier}-${tokenCounter}`;
      validTokens.set(token, server.identifier);
      const host = nodeOrigin(server).replace('https://', 'wss://');
      return json(200, { data: { token, socket: `${host}/api/servers/${server.uuid}/ws` } });
    }
    if (method === 'POST' && area === 'power') {
      requireNode(server);
      const signal = str(parseBody(body).signal) as PowerSignal;
      if (!['start', 'stop', 'restart', 'kill'].includes(signal)) throw new HttpError(422, 'The selected signal is invalid.');
      setState(server, signal === 'start' || signal === 'restart' ? 'running' : 'offline');
      return json(204, undefined);
    }
    if (method === 'POST' && area === 'command') {
      requireNode(server);
      if (server.state === 'offline') throw new HttpError(502, 'Cannot send commands to a stopped server instance.');
      const command = str(parseBody(body).command);
      (commands[server.identifier] ??= []).push(command);
      return json(204, undefined);
    }

    if (area === 'files') {
      requireNode(server);
      if (method === 'GET' && a === 'list') {
        const dir = normalizePath(query.get('directory') ?? '/');
        const entries = server.files[dir];
        if (!entries) throw new HttpError(404, 'The requested resource was not found on this server.');
        return json(200, list('file_object', entries, new URLSearchParams('per_page=100')));
      }
      if (method === 'GET' && a === 'contents') {
        const path = normalizePath(query.get('file') ?? '');
        const text = server.contents[path];
        if (text === undefined) throw new HttpError(404, 'The requested resource was not found on this server.');
        return { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: text };
      }
      if (method === 'POST' && a === 'write') {
        const path = normalizePath(query.get('file') ?? '');
        server.contents[path] = body ?? '';
        const dir = normalizePath(path.split('/').slice(0, -1).join('/') || '/');
        const name = path.split('/').pop() ?? '';
        const entries = (server.files[dir] ??= []);
        const existing = entries.find((e) => e.name === name);
        if (existing) {
          existing.size = (body ?? '').length;
          existing.modified_at = new Date().toISOString();
        } else {
          entries.push({ name, mode: '-rw-r--r--', size: (body ?? '').length, is_file: true, is_symlink: false, mimetype: 'text/plain', created_at: new Date().toISOString(), modified_at: new Date().toISOString() });
        }
        return json(204, undefined);
      }
      if (method === 'PUT' && a === 'rename') {
        const input = parseBody(body);
        const root = normalizePath(str(input.root) || '/');
        const pairs = Array.isArray(input.files) ? (input.files as { from?: unknown; to?: unknown }[]) : [];
        for (const pair of pairs) {
          const from = str(pair.from);
          const to = str(pair.to);
          if (!to || to.includes('/')) throw new HttpError(422, 'The new name is not valid.');
          const entry = server.files[root]?.find((e) => e.name === from);
          if (!entry) throw new HttpError(404, 'The requested resource was not found on this server.');
          if (server.files[root]?.some((e) => e.name === to)) throw new HttpError(400, 'A file or folder with that name already exists.');
          entry.name = to;
          const oldPath = normalizePath(`${root}/${from}`);
          const newPath = normalizePath(`${root}/${to}`);
          if (server.contents[oldPath] !== undefined) {
            server.contents[newPath] = server.contents[oldPath];
            delete server.contents[oldPath];
          }
          if (server.files[oldPath]) {
            server.files[newPath] = server.files[oldPath];
            delete server.files[oldPath];
          }
        }
        return json(204, undefined);
      }
      if (method === 'POST' && a === 'delete') {
        const input = parseBody(body);
        const root = normalizePath(str(input.root) || '/');
        const names = Array.isArray(input.files) ? input.files.map(String) : [];
        server.files[root] = (server.files[root] ?? []).filter((e) => !names.includes(e.name));
        for (const name of names) {
          delete server.contents[normalizePath(`${root}/${name}`)];
          delete server.files[normalizePath(`${root}/${name}`)];
        }
        return json(204, undefined);
      }
      if (method === 'POST' && a === 'create-folder') {
        const input = parseBody(body);
        const root = normalizePath(str(input.root) || '/');
        const name = str(input.name);
        if (!name || name.includes('/')) throw new HttpError(422, 'The name field is required.');
        if (server.files[root]?.some((e) => e.name === name)) throw new HttpError(400, 'A file or folder with that name already exists.');
        (server.files[root] ??= []).push({ name, mode: 'drwxr-xr-x', size: 4096, is_file: false, is_symlink: false, mimetype: 'inode/directory', created_at: new Date().toISOString(), modified_at: new Date().toISOString() });
        server.files[normalizePath(`${root}/${name}`)] = [];
        return json(204, undefined);
      }
      if (method === 'GET' && a === 'download') {
        const path = normalizePath(query.get('file') ?? '');
        return json(200, item('signed_url', { url: `${nodeOrigin(server)}/download/file?token=mock-download-${encodeURIComponent(path)}` }));
      }
      if (method === 'GET' && a === 'upload') {
        return json(200, item('signed_url', { url: `${nodeOrigin(server)}/upload/file?token=mock-upload-${server.identifier}` }));
      }
    }

    if (area === 'databases' && method === 'GET' && !a) return json(200, list('server_database', server.databases, query));
    if (area === 'schedules') {
      if (method === 'GET' && !a) return json(200, list('server_schedule', server.schedules, query));
      if (method === 'POST' && a && b === 'execute') {
        requireNode(server);
        const schedule = server.schedules.find((s) => String(s.id) === a);
        if (!schedule) throw new HttpError(404, 'The requested resource was not found on this server.');
        schedule.last_run_at = new Date().toISOString();
        return json(202, undefined);
      }
    }
    if (area === 'backups') {
      if (method === 'GET' && !a) return json(200, list('backup', [...server.backups].reverse(), query));
      if (method === 'POST' && !a) {
        requireNode(server);
        if (server.backups.length >= 5) throw new HttpError(400, 'Cannot create a new backup, this server has reached its limit of 5 backups.');
        const name = str(parseBody(body).name) || `Backup at ${new Date().toISOString()}`;
        const backup: Backup = {
          uuid: `b000000${nextBackup}-0000-4000-8000-00000000000${nextBackup}`,
          is_successful: false,
          is_locked: false,
          name,
          ignored_files: [],
          checksum: null,
          bytes: 0,
          created_at: new Date().toISOString(),
          completed_at: null,
        };
        nextBackup += 1;
        server.backups.push(backup);
        return json(200, item('backup', backup));
      }
      const backup = server.backups.find((x) => x.uuid === a);
      if (!backup) throw new HttpError(404, 'The requested resource was not found on this server.');
      if (method === 'GET' && b === 'download') {
        return json(200, item('signed_url', { url: `${nodeOrigin(server)}/download/backup?token=mock-backup-${backup.uuid}` }));
      }
      if (method === 'POST' && b === 'restore') {
        requireNode(server);
        if (!backup.is_successful) throw new HttpError(400, 'This backup cannot be restored at this time: not completed or failed.');
        server.status = 'restoring_backup';
        if (parseBody(body).truncate === true) server.files = { '/': [] };
        return json(204, undefined);
      }
    }
    if (area === 'network' && a === 'allocations' && method === 'GET') return json(200, list('allocation', server.allocations, query));
    if (area === 'startup') {
      if (method === 'GET' && !a) {
        return json(200, {
          ...list('egg_variable', server.variables, new URLSearchParams('per_page=100')),
          meta: { startup_command: server.startup, raw_startup_command: server.startup, docker_images: { Default: server.image } },
        });
      }
      if (method === 'PUT' && a === 'variable') {
        const input = parseBody(body);
        const variable = server.variables.find((v) => v.env_variable === str(input.key));
        if (!variable) throw new HttpError(400, 'The environment variable you are trying to edit does not exist.');
        if (!variable.is_editable) throw new HttpError(400, 'The environment variable you are trying to edit is read-only.');
        const value = typeof input.value === 'string' ? input.value : '';
        if (variable.rules.includes('required') && value.trim() === '') throw new HttpError(422, 'The value field is required.');
        if (variable.rules.includes('max:20') && value.length > 20) throw new HttpError(422, 'The value may not be greater than 20 characters.');
        variable.server_value = value;
        return json(200, { ...item('egg_variable', variable), meta: { startup_command: server.startup } });
      }
    }
    if (area === 'users' && method === 'GET' && !a) {
      const subs = server.subusers
        .map((id) => data.users.find((u) => u.id === id))
        .filter((u): u is PanelUser => u !== undefined)
        .map((u) => ({ uuid: u.uuid, username: u.username, email: u.email, image: '', '2fa_enabled': u['2fa'], created_at: u.created_at, permissions: ['control.console', 'control.start', 'file.read'] }));
      return json(200, list('server_subuser', subs, query));
    }
    throw new HttpError(404, 'The requested resource could not be found on the server.');
  }

  function clientRoute(method: string, parts: string[], query: URLSearchParams, body: string | null | undefined): MockResponse {
    // parts: after /api/client
    const [first, second, third, ...rest] = parts;
    if (method === 'GET' && !first) {
      const type = query.get('type');
      const search = (query.get('filter[*]') ?? '').toLowerCase();
      const visible = data.servers
        .filter((s) => (type === 'admin-all' ? account().root_admin : canSee(s)))
        .filter((s) => !search || s.name.toLowerCase().includes(search) || s.identifier.includes(search));
      return json(200, list('server', visible.map(clientServer), query));
    }
    if (first === 'version' && method === 'GET') {
      if (!hydro) throw new HttpError(404, 'The requested resource could not be found on the server.');
      return json(200, { version: MOCK_HYDRO_VERSION });
    }
    if (first === 'account') {
      if (method === 'GET' && !second) {
        const u = account();
        return json(200, item('user', { id: u.id, admin: u.root_admin, username: u.username, email: u.email, first_name: u.first_name, last_name: u.last_name, language: u.language }));
      }
      if (method === 'GET' && second === 'api-keys') return json(200, list('api_key', data.apiKeys, query));
    }
    if (first === 'servers' && second) {
      // Hydrodactyl: /servers/{daemon}/{id}/… for everything but the view and /resources.
      let identifier = second;
      let tail = [third, ...rest].filter((p): p is string => p !== undefined);
      const daemonPrefixed = ['wings', 'elytra', 'calagopus'].includes(second);
      if (daemonPrefixed) {
        if (!hydro) throw new HttpError(404, 'The requested resource could not be found on the server.');
        identifier = third ?? '';
        tail = rest;
      }
      const server = data.servers.find((s) => s.identifier === identifier);
      if (!server || (!canSee(server) && !account().root_admin)) throw new HttpError(404, 'The requested resource could not be found on the server.');
      if (method === 'GET' && tail.length === 0) {
        return json(200, { ...item('server', clientServer(server)), meta: { is_server_owner: server.owner === data.accountId, user_permissions: ['*'] } });
      }
      if (method === 'GET' && tail[0] === 'resources' && tail.length === 1) {
        if (server.status === 'suspended') throw new HttpError(409, 'This server is currently suspended and the functionality requested is unavailable.');
        requireNode(server);
        return json(200, item('stats', {
          current_state: server.state,
          is_suspended: false,
          resources: {
            memory_bytes: server.usage.memory,
            cpu_absolute: server.usage.cpu,
            disk_bytes: server.usage.disk,
            network_rx_bytes: server.usage.rx,
            network_tx_bytes: server.usage.tx,
            uptime: server.usage.uptime,
          },
        }));
      }
      if (method === 'GET' && tail[0] === 'resources' && tail[1] === 'history') {
        if (!hydro) throw new HttpError(404, 'The requested resource could not be found on the server.');
        const samples = Array.from({ length: 12 }, (_, i) => ({
          cpu_absolute: Math.round((20 + 18 * Math.sin(i / 2)) * 10) / 10,
          memory_bytes: (2600 + i * 40) * MiB,
          network_rx_bytes: i * 4 * MiB,
          network_tx_bytes: i * 9 * MiB,
          uptime: i * 300_000,
          recorded_at: new Date(now.getTime() - (11 - i) * 300_000).toISOString(),
        }));
        return json(200, list('server_resource_sample', samples, new URLSearchParams('per_page=100')));
      }
      if (hydro && !daemonPrefixed) throw new HttpError(404, 'The requested resource could not be found on the server.');
      return serverRoute(server, method, tail, query, body);
    }
    throw new HttpError(404, 'The requested resource could not be found on the server.');
  }

  const USERNAME = /^[a-z0-9_.-]{1,191}$/i;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function applicationRoute(method: string, parts: string[], query: URLSearchParams, body: string | null | undefined): MockResponse {
    const [first, second, third] = parts;
    if (first === 'panel' && second === 'status' && method === 'GET') {
      if (!hydro) throw new HttpError(404, 'The requested resource could not be found on the server.');
      return json(200, {
        status: 'running',
        timestamp: now.toISOString(),
        metrics: {
          uptime: 864_000,
          memory: { total: 8 * 1024 ** 3, used: 5.2 * 1024 ** 3, free: 2.8 * 1024 ** 3 },
          cpu: 17.4,
          cpu_cores: 4,
          disk: { total: 160 * 1024 ** 3, used: 61 * 1024 ** 3, free: 99 * 1024 ** 3 },
        },
        system: { php_version: '8.3.0', os: 'Linux', hostname: 'panel', load_average: [0.42, 0.51, 0.47] },
      });
    }
    if (first === 'users') {
      if (!second && method === 'GET') {
        const email = (query.get('filter[email]') ?? '').toLowerCase();
        const username = (query.get('filter[username]') ?? '').toLowerCase();
        const users = data.users.filter((u) => (!email || u.email.includes(email)) && (!username || u.username.includes(username)));
        return json(200, list('user', users, query));
      }
      if (!second && method === 'POST') {
        const input = parseBody(body);
        const user = validateUser(input, undefined);
        data.users.push(user);
        return json(201, item('user', user));
      }
      const user = data.users.find((u) => String(u.id) === second);
      if (!user) throw new HttpError(404, 'The requested resource could not be found on the server.');
      if (method === 'GET') return json(200, item('user', user));
      if (method === 'PATCH') {
        const updated = validateUser(parseBody(body), user);
        Object.assign(user, updated, { id: user.id, uuid: user.uuid, created_at: user.created_at, updated_at: new Date().toISOString() });
        return json(200, item('user', user));
      }
    }
    if (first === 'servers') {
      if (!second && method === 'GET') {
        const name = (query.get('filter[name]') ?? '').toLowerCase();
        return json(200, list('server', data.servers.filter((s) => !name || s.name.toLowerCase().includes(name)).map(appServer), query));
      }
      const server = data.servers.find((s) => String(s.id) === second);
      if (!server) throw new HttpError(404, 'The requested resource could not be found on the server.');
      if (method === 'GET' && !third) return json(200, item('server', appServer(server)));
      if (method === 'POST' && third === 'suspend') {
        server.status = 'suspended';
        setState(server, 'offline');
        return json(204, undefined);
      }
      if (method === 'POST' && third === 'unsuspend') {
        server.status = null;
        return json(204, undefined);
      }
      if (method === 'POST' && third === 'reinstall') {
        if (server.status === 'suspended') throw new HttpError(409, 'This server is currently suspended.');
        server.status = 'installing';
        return json(204, undefined);
      }
    }
    if (first === 'nodes') {
      if (!second && method === 'GET') return json(200, list('node', data.nodes, query));
      const node = data.nodes.find((n) => String(n.id) === second);
      if (!node) throw new HttpError(404, 'The requested resource could not be found on the server.');
      if (method === 'GET' && !third) return json(200, item('node', node));
      if (method === 'GET' && third === 'allocations') {
        const [total, assigned] = data.nodeAllocations[node.id] ?? [0, 0];
        const filter = query.get('filter[server_id]');
        const count = filter !== null && !/^\d+$/.test(filter) ? total - assigned : total;
        const rows = Array.from({ length: count }, (_, i) => ({ id: node.id * 1000 + i, ip: '203.0.113.10', alias: null, port: 25565 + i, notes: null, assigned: filter === null && i < assigned }));
        return json(200, list('allocation', rows, query));
      }
    }
    if (first === 'locations' && !second && method === 'GET') return json(200, list('location', data.locations, query));
    if (first === 'nests') {
      if (!second && method === 'GET') return json(200, list('nest', data.nests, query));
      if (third === 'eggs' && method === 'GET') return json(200, list('egg', data.eggs.filter((e) => String(e.nest) === second), query));
    }
    throw new HttpError(404, 'The requested resource could not be found on the server.');
  }

  function validateUser(input: Record<string, unknown>, existing: PanelUser | undefined): PanelUser {
    const email = str(input.email).toLowerCase();
    const username = str(input.username);
    const first = str(input.first_name);
    const last = str(input.last_name);
    if (!EMAIL.test(email)) throw new HttpError(422, 'The email must be a valid email address.');
    if (!USERNAME.test(username)) throw new HttpError(422, 'The username format is invalid.');
    if (!first || !last) throw new HttpError(422, 'The first name and last name fields are required.');
    if (data.users.some((u) => u.email === email && u.id !== existing?.id)) throw new HttpError(422, 'The email has already been taken.');
    if (data.users.some((u) => u.username === username && u.id !== existing?.id)) throw new HttpError(422, 'The username has already been taken.');
    const id = existing?.id ?? Math.max(...data.users.map((u) => u.id)) + 1;
    return {
      id,
      external_id: null,
      uuid: existing?.uuid ?? `4000000${id}-0000-4000-8000-00000000000${id}`,
      username,
      email,
      first_name: first,
      last_name: last,
      language: str(input.language) || 'en',
      root_admin: input.root_admin === true,
      '2fa': existing?.['2fa'] ?? false,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  function nodeRoute(method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: string | null | undefined): MockResponse {
    if (path === '/api/system' && method === 'GET') {
      const auth = header(headers, 'authorization');
      if (!auth) return { status: 401, headers: { ...CORS, 'WWW-Authenticate': 'Bearer', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'The required authorization heads were not present in the request.' }) };
      if (auth !== `Bearer ${MOCK_DAEMON_TOKEN}`) return json(403, { error: 'You are not authorized to access this endpoint.' });
      const running = data.servers.filter((s) => s.node === 1 && s.state !== 'offline').length;
      const total = data.servers.filter((s) => s.node === 1).length;
      return json(200, {
        version: '1.11.13',
        docker: { version: '27.3.1', cgroups: { driver: 'systemd', version: '2' }, containers: { total, running, paused: 0, stopped: total - running }, storage: { driver: 'overlay2', filesystem: 'extfs' }, runc: { version: '1.1.14' } },
        system: { architecture: 'amd64', cpu_threads: 16, memory_bytes: 64 * 1024 ** 3, kernel_version: '6.8.0-49-generic', os: 'Ubuntu 24.04.1 LTS', os_type: 'linux' },
      });
    }
    if (path === '/upload/file' && method === 'POST') {
      const token = query.get('token') ?? '';
      if (!token.startsWith('mock-upload-')) return json(403, { error: 'invalid token' });
      const name = /filename="([^"]+)"/.exec(body ?? '')?.[1] ?? 'upload.bin';
      const directory = normalizePath(query.get('directory') ?? '/');
      uploads.push({ directory, name });
      const server = data.servers.find((s) => token === `mock-upload-${s.identifier}`);
      if (server) {
        (server.files[directory] ??= []).push({ name, mode: '-rw-r--r--', size: (body ?? '').length, is_file: true, is_symlink: false, mimetype: 'application/octet-stream', created_at: new Date().toISOString(), modified_at: new Date().toISOString() });
      }
      return { status: 200, headers: CORS, body: '' };
    }
    if ((path === '/download/file' || path === '/download/backup') && method === 'GET') {
      return { status: 200, headers: { ...CORS, 'Content-Type': 'application/octet-stream' }, body: 'mock file' };
    }
    return json(404, { error: 'The requested resource does not exist on this instance.' });
  }

  function header(headers: Record<string, string>, name: string): string | undefined {
    return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  }

  function handle(request: MockRequest): MockResponse | null {
    const method = request.method.toUpperCase();
    const match = /^(https:\/\/[^/]+)(\/[^?#]*)?(?:\?([^#]*))?/.exec(request.url);
    if (!match) return null;
    const [, host, rawPath = '/', rawQuery = ''] = match;
    const path = rawPath.replace(/\/+$/, '') || '/';
    const query = new URLSearchParams(rawQuery);
    if (method === 'OPTIONS') return { status: 204, headers: CORS, body: '' };

    if (host === MOCK_NODE_ORIGIN) {
      log.push(`node1 ${method} ${path}`);
      return nodeRoute(method, path, query, request.headers, request.body);
    }
    if (host !== origin) return null;

    log.push(`${method} ${path}${rawQuery ? `?${decodeURIComponent(rawQuery)}` : ''}`);
    const failure = failures.shift();
    if (failure !== undefined) return errorBody(failure, 'Simulated failure.');

    const auth = header(request.headers, 'authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    try {
      if (path === '/api/client' || path.startsWith('/api/client/')) {
        if (key !== clientKey) {
          // An application key on the client API is refused like a wrong key.
          throw new HttpError(401, 'Unauthenticated.');
        }
        return clientRoute(method, path.split('/').slice(3), query, request.body);
      }
      if (path.startsWith('/api/application')) {
        if (key !== appKey) throw new HttpError(401, 'Unauthenticated.');
        return applicationRoute(method, path.split('/').slice(3), query, request.body);
      }
      throw new HttpError(404, 'The requested resource could not be found on the server.');
    } catch (error) {
      if (error instanceof HttpError) return errorBody(error.status, error.message);
      return errorBody(500, error instanceof Error ? error.message : 'error');
    }
  }

  const mockFetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(typeof Headers !== 'undefined' && raw instanceof Headers)) {
      Object.assign(headers, raw as Record<string, string>);
    }
    let body: string | null = null;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body && typeof FormData !== 'undefined' && init.body instanceof FormData) {
      const entry = init.body.get('files') as unknown as { name?: string } | null;
      body = `filename="${entry?.name ?? 'upload.bin'}"`;
    }
    const answer = handle({ method: init?.method ?? 'GET', url: input, headers, body });
    if (!answer) throw new TypeError('Network request failed');
    const response = {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: answer.headers,
      text: async () => answer.body,
      json: async () => JSON.parse(answer.body) as unknown,
    };
    return response as unknown as Response;
  };

  function openConsole(url: string, send: (text: string) => void, close: (code: number) => void): ConsoleEndpoint {
    const uuid = /\/api\/servers\/([^/]+)\/ws/.exec(url)?.[1];
    const server = data.servers.find((s) => s.uuid === uuid);
    let authed = false;
    const frame = (event: string, args: string[] = []) => send(JSON.stringify({ event, args }));
    const listener = (event: string, args: string[]) => {
      if (authed) frame(event, args);
    };
    if (server) {
      const set = consoles.get(server.identifier) ?? new Set();
      set.add(listener);
      consoles.set(server.identifier, set);
    }
    const detach = () => {
      if (server) consoles.get(server.identifier)?.delete(listener);
    };
    return {
      receive(text) {
        if (!server) {
          close(4004);
          return;
        }
        let message: { event?: string; args?: unknown[] };
        try {
          message = JSON.parse(text) as { event?: string; args?: unknown[] };
        } catch {
          return;
        }
        const arg = typeof message.args?.[0] === 'string' ? message.args[0] : '';
        switch (message.event) {
          case 'auth':
            if (validTokens.get(arg) !== server.identifier) {
              frame('jwt error', ['jwt: invalid token']);
              return;
            }
            authed = true;
            frame('auth success');
            frame('status', [server.state]);
            break;
          case 'send logs':
            if (authed) for (const line of server.console) frame('console output', [line]);
            break;
          case 'send stats':
            if (authed) frame('stats', [stats(server)]);
            break;
          case 'send command':
            if (!authed) return;
            (commands[server.identifier] ??= []).push(arg);
            frame('console output', [`> ${arg}`]);
            if (arg === 'list') frame('console output', ['\u001b[33mThere are 1 of a max of 20 players online: ben\u001b[0m']);
            else frame('console output', [`[INFO]: ran ${arg}`]);
            break;
          case 'set state':
            if (authed && ['start', 'stop', 'restart', 'kill'].includes(arg)) setState(server, arg === 'start' || arg === 'restart' ? 'running' : 'offline');
            break;
          default:
            break;
        }
      },
      close() {
        detach();
      },
    };
  }

  /** A WebSocket stand-in for Jest; frames are delivered asynchronously like a real socket. */
  const socketFactory: SocketFactory = (url) => {
    const later = (fn: () => void) => setTimeout(fn, 0);
    let open = true;
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(text) {
        if (open) endpoint.receive(text);
      },
      close(code = 1000) {
        if (!open) return;
        open = false;
        endpoint.close();
        later(() => socket.onclose?.({ code }));
      },
    };
    const reachable = url.startsWith(MOCK_NODE_ORIGIN.replace('https://', 'wss://'));
    const endpoint = openConsole(
      url,
      (text) => later(() => open && socket.onmessage?.({ data: text })),
      (code) => socket.close(code)
    );
    later(() => {
      if (!reachable) {
        open = false;
        socket.onclose?.({ code: 1006 });
      } else socket.onopen?.();
    });
    return socket;
  };

  return {
    flavor,
    origin,
    clientKey,
    appKey,
    data,
    log,
    commands,
    uploads,
    failNext(status, count = 1) {
      for (let i = 0; i < count; i += 1) failures.push(status);
    },
    handle,
    fetch: mockFetch,
    ownsSocket: (url) => data.servers.some((s) => url.includes(`/api/servers/${s.uuid}/ws`)),
    openConsole,
    socketFactory,
  };
}
