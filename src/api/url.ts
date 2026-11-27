import { PanelError } from './errors';

// scheme://host[:port][/path][?query][#fragment]. Parsed by hand: React Native's URL class does
// not implement hostname, port or pathname.
const ADDRESS = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i;
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/i;

/** Paths below the panel's address that are accepted as "the same panel". */
const KNOWN_PATHS = ['/api', '/api/client', '/api/application', '/auth/login', '/admin'];

function parse(input: string): { host: string; port?: string; path: string } {
  const trimmed = input.trim();
  if (trimmed === '') throw new PanelError('invalidUrl', 'empty address');
  const match = ADDRESS.exec(trimmed);
  if (!match) throw new PanelError('invalidUrl', `not an address: ${trimmed}`);
  const [, scheme, authority, rawPath] = match;
  if (scheme !== undefined && scheme.toLowerCase() !== 'https') {
    throw new PanelError('insecure', `${scheme}:// is not allowed`);
  }
  if (authority.includes('@')) throw new PanelError('invalidUrl', 'the address must not contain a user name or password');
  const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(authority);
  const host = (portMatch?.[1] ?? '').toLowerCase();
  const port = portMatch?.[2];
  const hostOk = IPV4.test(host) || IPV6.test(host) || host === 'localhost' || (HOST_NAME.test(host) && host.includes('.'));
  if (!hostOk) throw new PanelError('invalidUrl', `not a host name: ${host || trimmed}`);
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new PanelError('invalidUrl', `not a port: ${port}`);
  return { host, port, path: rawPath.replace(/\/+$/, '') };
}

/**
 * Turns what a person types ("panel.example.org", "https://panel.example.org/api/client") into
 * the panel's origin ("https://panel.example.org"). A missing scheme means https; http:// (or
 * any other scheme) is refused, because the API key would travel in the clear. The panel's own
 * paths (/api/client, /auth/login, …) are accepted as the same panel; any other path is refused,
 * since the panel API is always served from the root of its address.
 */
export function normalizePanelUrl(input: string): string {
  const { host, port, path } = parse(input);
  if (path !== '' && !KNOWN_PATHS.includes(path.toLowerCase())) {
    throw new PanelError('invalidUrl', `unexpected path ${path}; enter the panel's address only`);
  }
  return `https://${host}${port === undefined || port === '443' ? '' : `:${port}`}`;
}

/** The origin of a node's daemon: https://fqdn:port (the node must use https). */
export function daemonOrigin(node: { fqdn: string; scheme: string; daemon_listen: number }): string {
  if (node.scheme !== 'https') throw new PanelError('insecure', `the node ${node.fqdn} does not use https`);
  const { host } = parse(node.fqdn);
  return `https://${host}${node.daemon_listen === 443 ? '' : `:${node.daemon_listen}`}`;
}

/** The label for a panel: its host name (and port). */
export function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, '');
}

/** The panel's own account page (2FA, password, e-mail), opened in the browser. */
export function panelAccountUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/account`;
}
