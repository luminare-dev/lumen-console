// A typed client for the panel's Application API (/api/application), the admin API. It needs an
// application key (Admin → Application API) of a root admin; each key has its own read/write
// permissions per resource, so a 403 on one screen can be the key's setting.

import { attributes, Http, seg, type FetchLike } from './http';
import type { AppServer, Egg, Location, Nest, NodeAllocation, PanelNode, PanelStatus, PanelUser, UserCreate, UserUpdate } from './types';

export const APPLICATION_PREFIX = '/api/application';

export interface AllocationUsage {
  total: number;
  assigned: number;
}

export class ApplicationApi {
  readonly http: Http;

  constructor(options: { origin: string; key: string; fetch?: FetchLike; timeoutMs?: number }) {
    this.http = new Http(options);
  }

  get origin(): string {
    return this.http.origin;
  }

  /** Checks the key with the smallest request an application key can make. */
  async ping(): Promise<void> {
    await this.http.page<PanelUser>(`${APPLICATION_PREFIX}/users`, { per_page: 1 });
  }

  // --- Users --------------------------------------------------------------------------------

  /** Users, optionally filtered on the panel (e-mail when the search has an @, else user name). */
  users(search = ''): Promise<PanelUser[]> {
    const term = search.trim();
    const filter = term === '' ? {} : term.includes('@') ? { 'filter[email]': term } : { 'filter[username]': term };
    return this.http.all<PanelUser>(`${APPLICATION_PREFIX}/users`, filter);
  }

  async user(id: number): Promise<PanelUser> {
    return attributes<PanelUser>(await this.http.request('GET', `${APPLICATION_PREFIX}/users/${seg(id)}`), 'user');
  }

  async createUser(body: UserCreate): Promise<PanelUser> {
    return attributes<PanelUser>(await this.http.request('POST', `${APPLICATION_PREFIX}/users`, { body }), 'user');
  }

  async updateUser(id: number, body: UserUpdate): Promise<PanelUser> {
    return attributes<PanelUser>(await this.http.request('PATCH', `${APPLICATION_PREFIX}/users/${seg(id)}`, { body }), 'user');
  }

  // --- Servers ------------------------------------------------------------------------------

  servers(search = ''): Promise<AppServer[]> {
    const term = search.trim();
    return this.http.all<AppServer>(`${APPLICATION_PREFIX}/servers`, term === '' ? {} : { 'filter[name]': term });
  }

  async server(id: number): Promise<AppServer> {
    return attributes<AppServer>(await this.http.request('GET', `${APPLICATION_PREFIX}/servers/${seg(id)}`), 'server');
  }

  suspend(id: number): Promise<void> {
    return this.http.request('POST', `${APPLICATION_PREFIX}/servers/${seg(id)}/suspend`);
  }

  unsuspend(id: number): Promise<void> {
    return this.http.request('POST', `${APPLICATION_PREFIX}/servers/${seg(id)}/unsuspend`);
  }

  /** Runs the egg's install script again; files may be overwritten. */
  reinstall(id: number): Promise<void> {
    return this.http.request('POST', `${APPLICATION_PREFIX}/servers/${seg(id)}/reinstall`);
  }

  // --- Nodes and locations ------------------------------------------------------------------

  nodes(): Promise<PanelNode[]> {
    return this.http.all<PanelNode>(`${APPLICATION_PREFIX}/nodes`);
  }

  async node(id: number): Promise<PanelNode> {
    return attributes<PanelNode>(await this.http.request('GET', `${APPLICATION_PREFIX}/nodes/${seg(id)}`), 'node');
  }

  /**
   * Allocation usage of a node from two one-item pages: all allocations, and the free ones
   * (filter[server_id] with a non-number selects allocations without a server).
   */
  async allocationUsage(nodeId: number): Promise<AllocationUsage> {
    const path = `${APPLICATION_PREFIX}/nodes/${seg(nodeId)}/allocations`;
    const [all, free] = await Promise.all([
      this.http.page<NodeAllocation>(path, { per_page: 1 }),
      this.http.page<NodeAllocation>(path, { per_page: 1, 'filter[server_id]': 'none' }),
    ]);
    const total = all.pagination?.total ?? all.items.length;
    const unassigned = free.pagination?.total ?? free.items.length;
    return { total, assigned: Math.max(0, total - unassigned) };
  }

  locations(): Promise<Location[]> {
    return this.http.all<Location>(`${APPLICATION_PREFIX}/locations`);
  }

  // --- Nests and eggs -----------------------------------------------------------------------

  nests(): Promise<Nest[]> {
    return this.http.all<Nest>(`${APPLICATION_PREFIX}/nests`);
  }

  eggs(nestId: number): Promise<Egg[]> {
    return this.http.all<Egg>(`${APPLICATION_PREFIX}/nests/${seg(nestId)}/eggs`);
  }

  // --- Hydrodactyl --------------------------------------------------------------------------

  /** Hydrodactyl only: load, memory, disk and uptime of the panel host. */
  panelStatus(): Promise<PanelStatus> {
    return this.http.request<PanelStatus>('GET', `${APPLICATION_PREFIX}/panel/status`);
  }
}
