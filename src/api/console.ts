// The live console: the panel hands out a short-lived JWT and the node's socket address
// (GET …/websocket); the app opens the socket on the node, sends {"event":"auth"} with the token
// and then receives console output, power state and stats. Wings warns with "token expiring"
// before the token runs out (about 10 minutes); the session then fetches a fresh one.
//
// Wings checks the Origin header of the socket against the panel address. The native apps send
// the panel's origin; a browser always sends its own, so on the web the node has to list the
// app's origin under allowed_origins (docs/api.md).

import type { ClientApi, ServerRef } from './client';
import { classifyFetchError, PanelError } from './errors';
import type { PowerState } from './types';

/** The part of a WebSocket the session uses; the mock socket implements the same. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string, panelOrigin: string) => SocketLike;

/** The platform WebSocket; React Native accepts headers in a third argument. */
export const platformSocket: SocketFactory = (url, panelOrigin) => {
  const isBrowser = typeof document !== 'undefined';
  if (isBrowser) return new WebSocket(url) as unknown as SocketLike;
  const NativeSocket = WebSocket as unknown as new (u: string, p: string[], o: { headers: Record<string, string> }) => SocketLike;
  return new NativeSocket(url, [], { headers: { Origin: panelOrigin } });
};

export interface SocketStats {
  memory_bytes: number;
  memory_limit_bytes: number;
  cpu_absolute: number;
  disk_bytes: number;
  network: { rx_bytes: number; tx_bytes: number };
  state: PowerState;
  uptime: number;
}

export type ConsoleStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'failed';

export interface ConsoleState {
  status: ConsoleStatus;
  lines: string[];
  power?: PowerState;
  stats?: SocketStats;
  /** Why the session failed: an API error kind, or "suspended", "origin", "jwt". */
  error?: string;
}

export const MAX_LINES = 400;
const MAX_RECONNECTS = 3;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r/g, '');
}

export function parseFrame(data: unknown): { event: string; args: string[] } | null {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data) as { event?: unknown; args?: unknown };
    if (typeof value.event !== 'string') return null;
    const args = Array.isArray(value.args) ? value.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))) : [];
    return { event: value.event, args };
  } catch {
    return null;
  }
}

export class ConsoleSession {
  private socket: SocketLike | null = null;
  private listeners = new Set<(state: ConsoleState) => void>();
  private stopped = false;
  private reconnects = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  state: ConsoleState = { status: 'connecting', lines: [] };

  constructor(
    private readonly api: ClientApi,
    private readonly ref: ServerRef,
    private readonly factory: SocketFactory = platformSocket,
    private readonly reconnectDelayMs = 2_000
  ) {}

  subscribe(listener: (state: ConsoleState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<ConsoleState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private append(text: string): void {
    const added = stripAnsi(text).split('\n');
    const lines = [...this.state.lines, ...added].slice(-MAX_LINES);
    this.update({ lines });
  }

  private sendFrame(event: string, args: string[] = []): void {
    this.socket?.send(JSON.stringify({ event, args }));
  }

  private async token(): Promise<{ token: string; socket: string }> {
    return this.api.websocket(this.ref);
  }

  async start(): Promise<void> {
    this.stopped = false;
    let credentials: { token: string; socket: string };
    try {
      credentials = await this.token();
    } catch (error) {
      this.update({ status: 'failed', error: (error instanceof PanelError ? error : classifyFetchError(error)).kind });
      return;
    }
    if (this.stopped) return;
    if (!credentials.socket.startsWith('wss://')) {
      this.update({ status: 'failed', error: 'insecure' });
      return;
    }
    let socket: SocketLike;
    try {
      socket = this.factory(credentials.socket, this.api.origin);
    } catch (error) {
      this.update({ status: 'failed', error: classifyFetchError(error).kind });
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.sendFrame('auth', [credentials.token]);
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => undefined;
    socket.onclose = (event) => this.closed(event.code);
  }

  private receive(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    const [first = ''] = frame.args;
    switch (frame.event) {
      case 'auth success':
        this.reconnects = 0;
        this.update({ status: 'connected', error: undefined });
        this.sendFrame('send logs');
        this.sendFrame('send stats');
        break;
      case 'token expiring':
      case 'token expired':
        void this.token()
          .then((next) => this.sendFrame('auth', [next.token]))
          .catch(() => this.update({ error: 'jwt' }));
        break;
      case 'jwt error':
        this.update({ status: 'failed', error: 'jwt' });
        this.socket?.close(1000);
        break;
      case 'console output':
      case 'install output':
        for (const arg of frame.args) this.append(arg);
        break;
      case 'daemon message':
        this.append(`[daemon] ${first}`);
        break;
      case 'daemon error':
        this.append(`[daemon error] ${first}`);
        break;
      case 'status':
        this.update({ power: first as PowerState });
        break;
      case 'stats':
        try {
          const stats = JSON.parse(first) as SocketStats;
          this.update({ stats, power: stats.state ?? this.state.power });
        } catch {
          // a malformed stats frame is skipped
        }
        break;
      default:
        break;
    }
  }

  private closed(code: number): void {
    this.socket = null;
    if (this.stopped) {
      this.update({ status: 'closed' });
      return;
    }
    // 4409: the server is suspended. 1006 right after opening is also what a refused Origin
    // looks like from the client side.
    if (code === 4409) {
      this.update({ status: 'failed', error: 'suspended' });
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.update({ status: 'failed', error: this.state.status === 'connected' ? 'network' : 'origin' });
      return;
    }
    this.reconnects += 1;
    this.update({ status: 'reconnecting' });
    this.timer = setTimeout(() => void this.start(), this.reconnectDelayMs);
  }

  /** Sends a console command; false while the socket is not authenticated. */
  sendCommand(command: string): boolean {
    const trimmed = command.trim();
    if (this.state.status !== 'connected' || trimmed === '') return false;
    this.sendFrame('send command', [trimmed]);
    return true;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this.update({ status: 'closed' });
  }
}
