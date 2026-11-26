// A typed client for the panel's Client API (/api/client), the API behind the panel's own user
// interface. It authenticates with a client API key (Account → API Credentials) and sees only the
// servers that account may see. docs/api.md lists every endpoint used.
//
// Hydrodactyl moves the per-server endpoints below the daemon type
// (/api/client/servers/wings/{id}/…); a server's `daemon_type` attribute says which one. The
// server view and /resources answer on the plain path on both panels.

import { classifyFetchError, kindForStatus, PanelError } from './errors';
import { attributes, Http, seg, type FetchLike } from './http';
import type {
  Account,
  ApiKey,
  Backup,
  ClientAllocation,
  ClientServer,
  FileObject,
  PowerSignal,
  ResourceSample,
  Resources,
  Schedule,
  ServerDatabase,
  SignedUrl,
  Startup,
  StartupVariable,
  Subuser,
  WebsocketCredentials,
} from './types';

export const CLIENT_PREFIX = '/api/client';

export type ServerRef = Pick<ClientServer, 'identifier'> & { daemon_type?: string };

export interface UploadFile {
  /** A file:// or content:// URI on native; ignored when `blob` is set. */
  uri?: string;
  name: string;
  type?: string;
  /** The web picker's File. */
  blob?: Blob;
}

export class ClientApi {
  readonly http: Http;

  constructor(options: { origin: string; key: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.http = new Http(options);
  }

  get origin(): string {
    return this.http.origin;
  }

  /** The base of a server's endpoints, with the daemon type on Hydrodactyl. */
  serverPath(ref: ServerRef): string {
    const daemon = ref.daemon_type ? `/${seg(ref.daemon_type)}` : '';
    return `${CLIENT_PREFIX}/servers${daemon}/${seg(ref.identifier)}`;
  }

  // --- Panel and account --------------------------------------------------------------------

  /** Hydrodactyl only: GET /api/client/version. Pterodactyl answers 404. */
  async version(): Promise<string> {
    const data = await this.http.request<{ version?: unknown }>('GET', `${CLIENT_PREFIX}/version`);
    return typeof data?.version === 'string' ? data.version : '';
  }

  async account(): Promise<Account> {
    return attributes<Account>(await this.http.request('GET', `${CLIENT_PREFIX}/account`), 'account');
  }

  apiKeys(): Promise<ApiKey[]> {
    return this.http.page<ApiKey>(`${CLIENT_PREFIX}/account/api-keys`).then((p) => p.items);
  }

  /** The servers the key's account can use (owner or subuser); with type=admin-all every server. */
  servers(options: { search?: string; type?: 'admin-all' } = {}): Promise<ClientServer[]> {
    return this.http.all<ClientServer>(`${CLIENT_PREFIX}`, { 'filter[*]': options.search || undefined, type: options.type }, 300);
  }

  // --- One server ---------------------------------------------------------------------------

  async server(identifier: string): Promise<ClientServer> {
    return attributes<ClientServer>(await this.http.request('GET', `${CLIENT_PREFIX}/servers/${seg(identifier)}`), 'server');
  }

  async resources(identifier: string): Promise<Resources> {
    return attributes<Resources>(await this.http.request('GET', `${CLIENT_PREFIX}/servers/${seg(identifier)}/resources`), 'resources');
  }

  /** Hydrodactyl only: the stored resource samples of a server, oldest first. */
  resourceHistory(identifier: string): Promise<ResourceSample[]> {
    return this.http.page<ResourceSample>(`${CLIENT_PREFIX}/servers/${seg(identifier)}/resources/history`).then((p) => p.items);
  }

  power(ref: ServerRef, signal: PowerSignal): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/power`, { body: { signal } });
  }

  command(ref: ServerRef, command: string): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/command`, { body: { command } });
  }

  async websocket(ref: ServerRef): Promise<WebsocketCredentials> {
    const data = await this.http.request<{ data?: WebsocketCredentials }>('GET', `${this.serverPath(ref)}/websocket`);
    if (!data?.data?.token || !data.data.socket) throw new PanelError('invalidResponse', 'the websocket answer has no token');
    return data.data;
  }

  // --- Files --------------------------------------------------------------------------------

  files(ref: ServerRef, directory: string): Promise<FileObject[]> {
    return this.http.page<FileObject>(`${this.serverPath(ref)}/files/list`, { directory }).then((p) => p.items);
  }

  fileContents(ref: ServerRef, file: string): Promise<string> {
    return this.http.request<string>('GET', `${this.serverPath(ref)}/files/contents`, { query: { file }, asText: true });
  }

  writeFile(ref: ServerRef, file: string, contents: string): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/files/write`, { query: { file }, text: contents });
  }

  rename(ref: ServerRef, root: string, from: string, to: string): Promise<void> {
    return this.http.request('PUT', `${this.serverPath(ref)}/files/rename`, { body: { root, files: [{ from, to }] } });
  }

  deleteFiles(ref: ServerRef, root: string, files: string[]): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/files/delete`, { body: { root, files } });
  }

  createFolder(ref: ServerRef, root: string, name: string): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/files/create-folder`, { body: { root, name } });
  }

  /** A one-time download link signed by the panel; it points at the node, not the panel. */
  async downloadUrl(ref: ServerRef, file: string): Promise<string> {
    const data = await this.http.request('GET', `${this.serverPath(ref)}/files/download`, { query: { file } });
    return attributes<SignedUrl>(data, 'download').url;
  }

  async uploadUrl(ref: ServerRef): Promise<string> {
    return attributes<SignedUrl>(await this.http.request('GET', `${this.serverPath(ref)}/files/upload`), 'upload').url;
  }

  /**
   * Uploads one file into `directory` through the signed node URL (multipart field "files").
   * The node checks the signature, so no key is sent with it.
   */
  async upload(ref: ServerRef, directory: string, file: UploadFile, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<void> {
    const url = await this.uploadUrl(ref);
    const form = new FormData();
    if (file.blob) form.append('files', file.blob, file.name);
    // React Native's FormData takes {uri, name, type} for a file on the device.
    else form.append('files', { uri: file.uri, name: file.name, type: file.type ?? 'application/octet-stream' } as unknown as Blob);
    const separator = url.includes('?') ? '&' : '?';
    let response: Response;
    try {
      response = await fetchImpl(`${url}${separator}directory=${encodeURIComponent(directory)}`, { method: 'POST', body: form, credentials: 'omit' });
    } catch (error) {
      throw classifyFetchError(error);
    }
    if (!response.ok) {
      throw new PanelError(kindForStatus(response.status), `upload failed: HTTP ${response.status}`, { status: response.status });
    }
  }

  // --- Databases, schedules, backups, network, startup, users --------------------------------

  databases(ref: ServerRef): Promise<ServerDatabase[]> {
    return this.http.page<ServerDatabase>(`${this.serverPath(ref)}/databases`).then((p) => p.items);
  }

  schedules(ref: ServerRef): Promise<Schedule[]> {
    return this.http.page<Schedule>(`${this.serverPath(ref)}/schedules`).then((p) => p.items);
  }

  runSchedule(ref: ServerRef, id: number): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/schedules/${seg(id)}/execute`);
  }

  backups(ref: ServerRef): Promise<Backup[]> {
    return this.http.page<Backup>(`${this.serverPath(ref)}/backups`, { per_page: 100 }).then((p) => p.items);
  }

  async createBackup(ref: ServerRef, name: string): Promise<Backup> {
    const data = await this.http.request('POST', `${this.serverPath(ref)}/backups`, { body: name.trim() ? { name: name.trim() } : {} });
    return attributes<Backup>(data, 'backup');
  }

  async backupDownloadUrl(ref: ServerRef, uuid: string): Promise<string> {
    return attributes<SignedUrl>(await this.http.request('GET', `${this.serverPath(ref)}/backups/${seg(uuid)}/download`), 'download').url;
  }

  /** Restores a backup; with truncate, every file of the server is deleted first. */
  restoreBackup(ref: ServerRef, uuid: string, truncate: boolean): Promise<void> {
    return this.http.request('POST', `${this.serverPath(ref)}/backups/${seg(uuid)}/restore`, { body: { truncate } });
  }

  allocations(ref: ServerRef): Promise<ClientAllocation[]> {
    return this.http.page<ClientAllocation>(`${this.serverPath(ref)}/network/allocations`).then((p) => p.items);
  }

  async startup(ref: ServerRef): Promise<Startup> {
    const data = await this.http.request<{ data?: { attributes: StartupVariable }[]; meta?: Omit<Startup, 'variables'> }>(
      'GET',
      `${this.serverPath(ref)}/startup`
    );
    if (!data || !Array.isArray(data.data)) throw new PanelError('invalidResponse', 'the startup answer has no variables');
    return { variables: data.data.map((item) => item.attributes), ...(data.meta ?? {}) };
  }

  async setVariable(ref: ServerRef, key: string, value: string): Promise<StartupVariable> {
    return attributes<StartupVariable>(
      await this.http.request('PUT', `${this.serverPath(ref)}/startup/variable`, { body: { key, value } }),
      'variable'
    );
  }

  subusers(ref: ServerRef): Promise<Subuser[]> {
    return this.http.page<Subuser>(`${this.serverPath(ref)}/users`).then((p) => p.items);
  }
}
