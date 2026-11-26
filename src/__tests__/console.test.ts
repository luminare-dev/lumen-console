import { ClientApi } from '../api/client';
import { ConsoleSession, parseFrame, stripAnsi, type ConsoleState } from '../api/console';
import { createMockPanel } from '../mock/server';

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(session: ConsoleSession, check: (s: ConsoleState) => boolean): Promise<ConsoleState> {
  for (let i = 0; i < 100; i += 1) {
    if (check(session.state)) return session.state;
    await flush();
  }
  throw new Error(`timed out in state ${JSON.stringify(session.state)}`);
}

function setup(flavor: 'pterodactyl' | 'hydrodactyl' = 'pterodactyl') {
  const mock = createMockPanel({ flavor });
  const api = new ClientApi({ origin: mock.origin, key: mock.clientKey, fetch: mock.fetch });
  return { mock, api };
}

describe('console frames', () => {
  it('parses frames and strips colour codes', () => {
    expect(parseFrame('{"event":"status","args":["running"]}')).toEqual({ event: 'status', args: ['running'] });
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame(42)).toBeNull();
    expect(stripAnsi('\u001b[33mYellow\u001b[0m\r')).toBe('Yellow');
  });
});

describe('ConsoleSession', () => {
  it('authenticates, loads the log and stats, and sends commands', async () => {
    const { mock, api } = setup();
    const session = new ConsoleSession(api, { identifier: 'a1b2c3d4' }, mock.socketFactory, 1);
    await session.start();
    const state = await until(session, (s) => s.status === 'connected' && s.lines.length >= 3 && s.stats !== undefined);
    expect(state.power).toBe('running');
    expect(state.lines).toContain('[10:12:31 INFO]: ben joined the game');
    expect(state.stats?.memory_limit_bytes).toBe(4096 * 1024 * 1024);
    expect(session.sendCommand('list')).toBe(true);
    await until(session, (s) => s.lines.some((l) => l.startsWith('There are 1 of a max')));
    expect(mock.commands.a1b2c3d4).toEqual(['list']);
    session.stop();
    expect(session.state.status).toBe('closed');
    expect(session.sendCommand('list')).toBe(false);
  });

  it('follows power changes made elsewhere', async () => {
    const { mock, api } = setup();
    const session = new ConsoleSession(api, { identifier: 'a1b2c3d4' }, mock.socketFactory, 1);
    await session.start();
    await until(session, (s) => s.status === 'connected');
    await api.power({ identifier: 'a1b2c3d4' }, 'stop');
    await until(session, (s) => s.power === 'offline');
    session.stop();
  });

  it('works below the daemon type on Hydrodactyl', async () => {
    const { mock, api } = setup('hydrodactyl');
    const session = new ConsoleSession(api, { identifier: 'a1b2c3d4', daemon_type: 'wings' }, mock.socketFactory, 1);
    await session.start();
    await until(session, (s) => s.status === 'connected');
    expect(mock.log).toContain('GET /api/client/servers/wings/a1b2c3d4/websocket');
    session.stop();
  });

  it('fails with the reason when the node cannot be reached or the server is suspended', async () => {
    const { mock, api } = setup();
    const down = new ConsoleSession(api, { identifier: 'c3d4e5f6' }, mock.socketFactory, 1);
    await down.start();
    expect(down.state).toMatchObject({ status: 'failed', error: 'daemon' });
    const suspended = new ConsoleSession(api, { identifier: 'd4e5f6a7' }, mock.socketFactory, 1);
    await suspended.start();
    expect(suspended.state).toMatchObject({ status: 'failed', error: 'conflict' });
  });

  it('gives up after a few reconnects when the socket keeps closing', async () => {
    const { mock, api } = setup();
    const refusing = (url: string, origin: string) => mock.socketFactory(url.replace('node1', 'node9'), origin);
    const session = new ConsoleSession(api, { identifier: 'a1b2c3d4' }, refusing, 1);
    await session.start();
    const state = await until(session, (s) => s.status === 'failed');
    expect(state.error).toBe('origin');
  });

  it('re-authenticates when the token is about to expire', async () => {
    const { mock, api } = setup();
    let socketRef: { onmessage: ((e: { data: unknown }) => void) | null } | null = null;
    const sent: string[] = [];
    const factory = (url: string, origin: string) => {
      const socket = mock.socketFactory(url, origin);
      const send = socket.send.bind(socket);
      socket.send = (text: string) => {
        sent.push(text);
        send(text);
      };
      socketRef = socket;
      return socket;
    };
    const session = new ConsoleSession(api, { identifier: 'a1b2c3d4' }, factory, 1);
    await session.start();
    await until(session, (s) => s.status === 'connected');
    socketRef!.onmessage?.({ data: JSON.stringify({ event: 'token expiring' }) });
    for (let i = 0; i < 50 && sent.filter((s) => s.includes('"auth"')).length < 2; i += 1) await flush();
    expect(sent.filter((s) => s.includes('"auth"')).length).toBe(2);
    session.stop();
  });
});
