// Shapes of the panel's answers, as its transformers write them (Pterodactyl 1.12 and the
// Hydrodactyl canary of 2026-10). Only fields the app reads are typed; everything is optional
// where a panel version may leave it out.

// --- Envelopes (Fractal) --------------------------------------------------------------------

export interface Item<T, O extends string = string> {
  object: O;
  attributes: T;
}

export interface Pagination {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
}

export interface List<T> {
  object: 'list';
  data: Item<T>[];
  meta?: { pagination?: Pagination };
}

export interface Page<T> {
  items: T[];
  pagination?: Pagination;
}

// --- Client API -----------------------------------------------------------------------------

export type ServerStatus = null | 'installing' | 'install_failed' | 'reinstall_failed' | 'suspended' | 'restoring_backup';
export type PowerState = 'offline' | 'starting' | 'running' | 'stopping';
export type PowerSignal = 'start' | 'stop' | 'restart' | 'kill';

export interface Limits {
  /** MiB; 0 means unlimited. */
  memory: number;
  swap: number;
  /** MiB; 0 means unlimited. */
  disk: number;
  io: number;
  /** Percent of one thread; 0 means unlimited. */
  cpu: number;
  threads?: string | null;
  oom_disabled?: boolean;
}

export interface ClientServer {
  server_owner: boolean;
  identifier: string;
  internal_id?: number;
  uuid: string;
  name: string;
  node: string;
  is_node_under_maintenance?: boolean;
  sftp_details: { ip: string; port: number };
  description: string;
  limits: Limits;
  invocation?: string;
  docker_image?: string;
  feature_limits: { databases: number; allocations: number; backups: number };
  status: ServerStatus;
  is_suspended?: boolean;
  is_installing?: boolean;
  is_transferring?: boolean;
  /** Hydrodactyl: the daemon of the server's node ("wings", "elytra", "calagopus"). */
  daemon_type?: string;
}

export interface Resources {
  current_state: PowerState;
  is_suspended: boolean;
  resources: {
    memory_bytes: number;
    cpu_absolute: number;
    disk_bytes: number;
    network_rx_bytes: number;
    network_tx_bytes: number;
    /** Milliseconds. */
    uptime: number;
  };
}

/** Hydrodactyl: one stored sample of GET /servers/{id}/resources/history. */
export interface ResourceSample {
  cpu_absolute: number;
  memory_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  uptime: number;
  recorded_at: string;
}

export interface FileObject {
  name: string;
  mode: string;
  mode_bits?: string;
  size: number;
  is_file: boolean;
  is_symlink: boolean;
  mimetype: string;
  created_at: string;
  modified_at: string;
}

export interface ServerDatabase {
  id: string;
  host: { address: string; port: number };
  name: string;
  username: string;
  connections_from: string;
  max_connections: number;
}

export interface Schedule {
  id: number;
  name: string;
  cron: { day_of_week: string; day_of_month: string; month: string; hour: string; minute: string };
  is_active: boolean;
  is_processing: boolean;
  only_when_online?: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Backup {
  uuid: string;
  is_successful: boolean;
  is_locked: boolean;
  name: string;
  ignored_files: string[];
  checksum: string | null;
  bytes: number;
  created_at: string;
  /** Null while the backup runs. */
  completed_at: string | null;
}

export interface ClientAllocation {
  id: number;
  ip: string;
  ip_alias: string | null;
  port: number;
  notes: string | null;
  is_default: boolean;
}

export interface StartupVariable {
  name: string;
  description: string;
  env_variable: string;
  default_value: string;
  server_value: string | null;
  is_editable: boolean;
  rules: string;
}

export interface Startup {
  variables: StartupVariable[];
  startup_command?: string;
  raw_startup_command?: string;
  docker_images?: Record<string, string>;
}

export interface Subuser {
  uuid: string;
  username: string;
  email: string;
  image?: string;
  '2fa_enabled': boolean;
  created_at: string;
  permissions: string[];
}

export interface Account {
  id: number;
  admin: boolean;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  language: string;
}

export interface ApiKey {
  identifier: string;
  description: string;
  allowed_ips: string[];
  last_used_at: string | null;
  created_at: string;
}

export interface WebsocketCredentials {
  token: string;
  socket: string;
}

export interface SignedUrl {
  url: string;
}

// --- Application API ------------------------------------------------------------------------

export interface PanelUser {
  id: number;
  external_id: string | null;
  uuid: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  language: string;
  root_admin: boolean;
  '2fa': boolean;
  created_at: string;
  updated_at: string | null;
}

export interface UserCreate {
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  password?: string;
  root_admin?: boolean;
  language?: string;
}

export interface UserUpdate {
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  password?: string;
  root_admin?: boolean;
  language?: string;
}

export interface AppServer {
  id: number;
  external_id: string | null;
  uuid: string;
  identifier: string;
  name: string;
  description: string;
  status: ServerStatus;
  suspended: boolean;
  limits: Limits;
  feature_limits: { databases: number; allocations: number; backups: number };
  user: number;
  node: number;
  allocation: number;
  nest: number;
  egg: number;
  container: { startup_command: string; image: string; installed: number; environment: Record<string, string | number | null> };
  created_at: string;
  updated_at: string | null;
}

export interface PanelNode {
  id: number;
  uuid: string;
  public: boolean;
  name: string;
  description: string | null;
  location_id: number;
  fqdn: string;
  scheme: string;
  behind_proxy: boolean;
  maintenance_mode: boolean;
  /** MiB */
  memory: number;
  memory_overallocate: number;
  /** MiB */
  disk: number;
  disk_overallocate: number;
  upload_size: number;
  daemon_listen: number;
  daemon_sftp: number;
  daemon_base: string;
  allocated_resources: { memory: number; disk: number };
  /** Hydrodactyl: "wings", "elytra" or "calagopus". */
  daemon_type?: string;
  created_at: string;
  updated_at: string | null;
}

export interface Location {
  id: number;
  short: string;
  long: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface NodeAllocation {
  id: number;
  ip: string;
  alias: string | null;
  port: number;
  notes: string | null;
  assigned: boolean;
}

export interface Nest {
  id: number;
  uuid: string;
  author: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Egg {
  id: number;
  uuid: string;
  name: string;
  nest: number;
  author: string;
  description: string | null;
  docker_image?: string;
  docker_images: Record<string, string>;
  startup: string;
  created_at: string;
  updated_at: string | null;
}

/** Hydrodactyl: GET /api/application/panel/status (the panel host). */
export interface PanelStatus {
  status: string;
  timestamp: string;
  metrics: {
    uptime: number;
    memory: { total: number; used: number; free: number };
    cpu: number;
    cpu_cores: number;
    disk: { total: number; used: number; free: number };
  };
  system?: { php_version?: string; os?: string; hostname?: string; load_average?: number[] };
}

// --- Wings ----------------------------------------------------------------------------------

/** GET /api/system?v=2 on a node (needs the node's daemon token). */
export interface WingsSystem {
  version: string;
  docker: {
    version: string;
    containers: { total: number; running: number; paused: number; stopped: number };
    storage?: { driver: string; filesystem: string };
  };
  system: {
    architecture: string;
    cpu_threads: number;
    memory_bytes: number;
    kernel_version: string;
    os: string;
    os_type: string;
  };
}
