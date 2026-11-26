// The HTTP layer shared by the client and application API: Bearer key, JSON, errors, pages.

import { classifyFetchError, errorDetail, kindForStatus, PanelError } from './errors';
import type { List, Page, Pagination } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as text/plain (file contents). */
  text?: string;
  /** Read the answer as text instead of JSON. */
  asText?: boolean;
}

export interface HttpOptions {
  /** https://host[:port], already normalised. */
  origin: string;
  key: string;
  fetch?: FetchLike;
  /** Per request, in milliseconds. */
  timeoutMs?: number;
}

export function queryString(query: Query | undefined): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(String(value))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Safe path segment: ids, uuids and short identifiers only. */
export function seg(value: string | number): string {
  const text = String(value);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text)) throw new PanelError('invalidUrl', `not an id: ${text}`);
  return text;
}

export class Http {
  readonly origin: string;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: HttpOptions) {
    this.origin = options.origin;
    this.key = options.key.trim();
    if (this.key === '') throw new PanelError('unauthorized', 'empty API key');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.key}`, Accept: 'application/json' };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    } else if (options.text !== undefined) {
      headers['Content-Type'] = 'text/plain';
      body = options.text;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}${queryString(options.query)}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        // The key must never be stored by an HTTP cache or mixed with a browser session.
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (error) {
      throw classifyFetchError(error);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (response.ok && options.asText) return text as T;
    let data: unknown;
    try {
      data = text === '' ? undefined : JSON.parse(text);
    } catch {
      if (response.ok) throw new PanelError('invalidResponse', 'the answer is not JSON', { status: response.status });
    }
    if (!response.ok) {
      const apiMessage = errorDetail(data);
      throw new PanelError(kindForStatus(response.status), apiMessage ?? `HTTP ${response.status}`, { status: response.status, apiMessage });
    }
    return data as T;
  }

  /** One page of a list endpoint, unwrapped. */
  async page<T>(path: string, query: Query = {}): Promise<Page<T>> {
    const data = await this.request<List<T>>('GET', path, { query });
    if (!data || !Array.isArray(data.data)) throw new PanelError('invalidResponse', `${path} did not return a list`);
    return { items: data.data.map((item) => item.attributes), pagination: data.meta?.pagination };
  }

  /** Every page of a list endpoint, up to `max` items (100 per request). */
  async all<T>(path: string, query: Query = {}, max = 500): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.page<T>(path, { ...query, per_page: 100, page });
      items.push(...result.items);
      const p: Pagination | undefined = result.pagination;
      if (!p || p.current_page >= p.total_pages || items.length >= max || result.items.length === 0) break;
    }
    return items.slice(0, max);
  }
}

/** The attributes of a single item answer ({object, attributes}). */
export function attributes<T>(data: unknown, what: string): T {
  if (typeof data !== 'object' || data === null || typeof (data as { attributes?: unknown }).attributes !== 'object') {
    throw new PanelError('invalidResponse', `${what} did not return an item`);
  }
  return (data as { attributes: T }).attributes;
}
