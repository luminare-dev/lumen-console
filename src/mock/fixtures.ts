// Invented panel data for the tests and the screenshots. Names, addresses and keys are made up;
// the example.net addresses are reserved for documentation (RFC 2606).

import type {
  ApiKey,
  Backup,
  ClientAllocation,
  Egg,
  FileObject,
  Location,
  Nest,
  PanelNode,
  PanelUser,
  PowerState,
  Schedule,
  ServerDatabase,
  ServerStatus,
  StartupVariable,
} from '../api/types';

export const MOCK_ORIGIN = 'https://panel.example.net';
export const MOCK_HYDRO_ORIGIN = 'https://hydro.example.net';
export const MOCK_NODE_ORIGIN = 'https://node1.example.net:8080';
/** A node that never answers (the mock fails every request to it). */
export const MOCK_DOWN_NODE_ORIGIN = 'https://node2.example.net:8080';

// Not key-shaped on purpose: the app checks only the prefix, the mock compares the whole string.
export const MOCK_CLIENT_KEY = 'ptlc_mock_client_key';
export const MOCK_APP_KEY = 'ptla_mock_application_key';
export const MOCK_HYDRO_CLIENT_KEY = 'hydro_mock_client_key';
export const MOCK_HYDRO_APP_KEY = 'hydro_mock_application_key';
export const MOCK_DAEMON_TOKEN = 'mock-daemon-token';
export const MOCK_HYDRO_VERSION = 'canary-2026.10';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface MockServer {
  id: number;
  identifier: string;
  uuid: string;
  name: string;
  description: string;
  owner: number;
  subusers: number[];
  node: number;
  nest: number;
  egg: number;
  status: ServerStatus;
  limits: { memory: number; swap: number; disk: number; io: number; cpu: number };
  image: string;
  startup: string;
  state: PowerState;
  usage: { memory: number; cpu: number; disk: number; rx: number; tx: number; uptime: number };
  files: Record<string, FileObject[]>;
  contents: Record<string, string>;
  databases: ServerDatabase[];
  schedules: Schedule[];
  backups: Backup[];
  allocations: ClientAllocation[];
  variables: StartupVariable[];
  console: string[];
}

export interface MockData {
  users: PanelUser[];
  nodes: PanelNode[];
  locations: Location[];
  nests: Nest[];
  eggs: Egg[];
  servers: MockServer[];
  apiKeys: ApiKey[];
  /** Allocations per node: [total, assigned]. */
  nodeAllocations: Record<number, [number, number]>;
  /** The user the client key belongs to. */
  accountId: number;
}

const iso = (now: Date, minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

function file(name: string, size: number, now: Date, minutesAgo: number, mime = 'text/plain'): FileObject {
  return {
    name,
    mode: '-rw-r--r--',
    mode_bits: '644',
    size,
    is_file: true,
    is_symlink: false,
    mimetype: mime,
    created_at: iso(now, minutesAgo + 600),
    modified_at: iso(now, minutesAgo),
  };
}

function folder(name: string, now: Date, minutesAgo: number): FileObject {
  return { ...file(name, 4096, now, minutesAgo, 'inode/directory'), mode: 'drwxr-xr-x', mode_bits: '755', is_file: false };
}

function user(id: number, username: string, first: string, last: string, admin: boolean, twoFactor: boolean, now: Date): PanelUser {
  return {
    id,
    external_id: null,
    uuid: `0000000${id}-0000-4000-8000-00000000000${id}`,
    username,
    email: `${username}@example.net`,
    first_name: first,
    last_name: last,
    language: 'en',
    root_admin: admin,
    '2fa': twoFactor,
    created_at: iso(now, 60 * 24 * (200 - id * 30)),
    updated_at: iso(now, 60 * 24 * 3),
  };
}

const cron = (minute: string, hour: string) => ({ day_of_week: '*', day_of_month: '*', month: '*', hour, minute });

export function createFixtures(now: Date = new Date()): MockData {
  const users = [
    user(1, 'ada', 'Ada', 'Admin', true, true, now),
    user(2, 'ben', 'Ben', 'Builder', false, true, now),
    user(3, 'cleo', 'Cleo', 'Crafter', false, false, now),
    user(4, 'dario', 'Dario', 'Diver', false, false, now),
  ];

  const node = (id: number, name: string, fqdn: string, location: number, memory: number, disk: number, allocMemory: number, allocDisk: number): PanelNode => ({
    id,
    uuid: `1000000${id}-0000-4000-8000-00000000000${id}`,
    public: true,
    name,
    description: null,
    location_id: location,
    fqdn,
    scheme: 'https',
    behind_proxy: false,
    maintenance_mode: false,
    memory,
    memory_overallocate: 0,
    disk,
    disk_overallocate: 0,
    upload_size: 100,
    daemon_listen: 8080,
    daemon_sftp: 2022,
    daemon_base: '/var/lib/pterodactyl/volumes',
    allocated_resources: { memory: allocMemory, disk: allocDisk },
    created_at: iso(now, 60 * 24 * 300),
    updated_at: iso(now, 60 * 24 * 10),
  });

  const nodes = [
    node(1, 'fsn-1', 'node1.example.net', 1, 32768, 409600, 12288, 81920),
    node(2, 'hel-2', 'node2.example.net', 2, 16384, 204800, 15360, 190000),
  ];

  const locations: Location[] = [
    { id: 1, short: 'de-fsn', long: 'Falkenstein', created_at: iso(now, 60 * 24 * 300), updated_at: null },
    { id: 2, short: 'fi-hel', long: 'Helsinki', created_at: iso(now, 60 * 24 * 280), updated_at: null },
  ];

  const nests: Nest[] = [
    { id: 1, uuid: '20000001-0000-4000-8000-000000000001', author: 'nests@example.net', name: 'Sandbox games', description: 'Block and voxel game servers.', created_at: iso(now, 60 * 24 * 300), updated_at: null },
    { id: 2, uuid: '20000002-0000-4000-8000-000000000002', author: 'nests@example.net', name: 'Voice', description: 'Voice chat relays.', created_at: iso(now, 60 * 24 * 300), updated_at: null },
  ];

  const egg = (id: number, nest: number, name: string, image: string, startup: string): Egg => ({
    id,
    uuid: `3000000${id}-0000-4000-8000-00000000000${id}`,
    name,
    nest,
    author: 'eggs@example.net',
    description: `${name} server.`,
    docker_image: image,
    docker_images: { [name]: image },
    startup,
    created_at: iso(now, 60 * 24 * 300),
    updated_at: null,
  });

  const eggs = [
    egg(1, 1, 'Voxel', 'ghcr.io/example/voxel:java21', 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}'),
    egg(2, 1, 'Voxel modded', 'ghcr.io/example/voxel:java17', 'java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} nogui'),
    egg(3, 2, 'Voice relay', 'ghcr.io/example/voice:latest', './relay --port {{SERVER_PORT}}'),
  ];

  const base = (id: number, identifier: string, name: string, owner: number, node: number, eggId: number, state: PowerState): MockServer => ({
    id,
    identifier,
    uuid: `${identifier}-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`,
    name,
    description: '',
    owner,
    subusers: [],
    node,
    nest: eggs.find((e) => e.id === eggId)?.nest ?? 1,
    egg: eggId,
    status: null,
    limits: { memory: 4096, swap: 0, disk: 20480, io: 500, cpu: 200 },
    image: eggs.find((e) => e.id === eggId)?.docker_image ?? '',
    startup: eggs.find((e) => e.id === eggId)?.startup ?? '',
    state,
    usage: { memory: 0, cpu: 0, disk: 2 * GiB, rx: 0, tx: 0, uptime: 0 },
    files: { '/': [] },
    contents: {},
    databases: [],
    schedules: [],
    backups: [],
    allocations: [],
    variables: [],
    console: [],
  });

  const survival = base(1, 'a1b2c3d4', 'Survival', 1, 1, 1, 'running');
  survival.description = 'Main world, whitelist on.';
  survival.subusers = [2];
  survival.usage = { memory: 3112 * MiB, cpu: 46.3, disk: Math.round(18.6 * GiB), rx: 812 * MiB, tx: 2.4 * GiB, uptime: 3 * 3_600_000 + 25 * 60_000 };
  survival.files = {
    '/': [
      folder('logs', now, 4),
      folder('plugins', now, 60 * 30),
      folder('world', now, 2),
      file('eula.txt', 9, now, 60 * 24 * 40),
      file('server.properties', 1180, now, 60 * 5),
      file('server.jar', 48 * MiB, now, 60 * 24 * 9, 'application/java-archive'),
    ],
    '/logs': [file('latest.log', 20480, now, 1), file('2026-11-19-1.log.gz', 8192, now, 60 * 24, 'application/gzip')],
    '/plugins': [file('worldguard.yml', 2048, now, 60 * 48)],
    '/world': [],
  };
  survival.contents = {
    '/eula.txt': 'eula=true\n',
    '/server.properties': 'motd=Lumen test world\nmax-players=20\ndifficulty=normal\nwhite-list=true\nview-distance=10\n',
    '/logs/latest.log': '[10:00:00 INFO]: Done (4.2s)! For help, type "help"\n',
    '/plugins/worldguard.yml': 'regions:\n  spawn:\n    flags: {}\n',
  };
  survival.databases = [
    { id: 'kz8Q2a', host: { address: 'db1.example.net', port: 3306 }, name: 's1_stats', username: 'u1_stats', connections_from: '%', max_connections: 0 },
  ];
  survival.schedules = [
    { id: 11, name: 'Nightly restart', cron: cron('0', '4'), is_active: true, is_processing: false, only_when_online: true, last_run_at: iso(now, 60 * 6), next_run_at: iso(now, -60 * 18), created_at: iso(now, 60 * 24 * 60), updated_at: iso(now, 60 * 24) },
    { id: 12, name: 'Weekly backup', cron: { ...cron('30', '3'), day_of_week: '0' }, is_active: false, is_processing: false, only_when_online: false, last_run_at: null, next_run_at: null, created_at: iso(now, 60 * 24 * 60), updated_at: iso(now, 60 * 24) },
  ];
  survival.backups = [
    { uuid: 'b0000001-0000-4000-8000-000000000001', is_successful: true, is_locked: true, name: 'Before 1.21 update', ignored_files: [], checksum: 'sha1:0000', bytes: Math.round(3.1 * GiB), created_at: iso(now, 60 * 24 * 3), completed_at: iso(now, 60 * 24 * 3 - 4) },
    { uuid: 'b0000002-0000-4000-8000-000000000002', is_successful: false, is_locked: false, name: 'Nightly', ignored_files: [], checksum: null, bytes: 0, created_at: iso(now, 60 * 5), completed_at: iso(now, 60 * 5 - 1) },
  ];
  survival.allocations = [
    { id: 101, ip: '203.0.113.10', ip_alias: 'play.example.net', port: 25565, notes: 'Game', is_default: true },
    { id: 102, ip: '203.0.113.10', ip_alias: null, port: 25575, notes: 'RCON', is_default: false },
  ];
  survival.variables = [
    { name: 'Server jar file', description: 'The jar file to run.', env_variable: 'SERVER_JARFILE', default_value: 'server.jar', server_value: 'server.jar', is_editable: true, rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/' },
    { name: 'Game version', description: 'The version to install.', env_variable: 'GAME_VERSION', default_value: 'latest', server_value: '1.21.4', is_editable: true, rules: 'required|string|max:20' },
    { name: 'Build type', description: 'Set by the hoster.', env_variable: 'BUILD_TYPE', default_value: 'release', server_value: 'release', is_editable: false, rules: 'required|in:release,snapshot' },
  ];
  survival.console = ['[10:00:00 INFO]: Starting voxel server version 1.21.4', '[10:00:04 INFO]: Done (4.2s)! For help, type "help"', '[10:12:31 INFO]: ben joined the game'];

  const creative = base(2, 'b2c3d4e5', 'Creative', 2, 1, 2, 'offline');
  creative.subusers = [1];
  creative.limits = { ...creative.limits, memory: 2048, disk: 10240 };
  creative.usage = { memory: 0, cpu: 0, disk: Math.round(4.2 * GiB), rx: 0, tx: 0, uptime: 0 };
  creative.files = { '/': [file('server.properties', 900, now, 60 * 24)] };
  creative.contents = { '/server.properties': 'motd=Creative\n' };

  const voice = base(3, 'c3d4e5f6', 'Voice relay', 1, 2, 3, 'running');
  voice.limits = { ...voice.limits, memory: 512, disk: 1024 };

  const lobby = base(4, 'd4e5f6a7', 'Old lobby', 3, 1, 1, 'offline');
  lobby.status = 'suspended';

  const apiKeys: ApiKey[] = [
    { identifier: 'ptlc_mockKey01', description: 'Lumen Console', allowed_ips: [], last_used_at: iso(now, 1), created_at: iso(now, 60 * 24 * 2) },
    { identifier: 'ptlc_mockKey02', description: 'Backup script', allowed_ips: ['198.51.100.7'], last_used_at: null, created_at: iso(now, 60 * 24 * 90) },
  ];

  return {
    users,
    nodes,
    locations,
    nests,
    eggs,
    servers: [survival, creative, voice, lobby],
    apiKeys,
    nodeAllocations: { 1: [40, 9], 2: [20, 19] },
    accountId: 1,
  };
}
