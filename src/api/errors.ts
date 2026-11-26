// Errors of the API clients, sorted into the kinds the screens explain differently.

export type ErrorKind =
  /** The address is not https:// (the app never sends a key in the clear). */
  | 'insecure'
  /** The address cannot be parsed. */
  | 'invalidUrl'
  /** A key of the wrong type: an application key in the client field or the other way round. */
  | 'wrongKeyType'
  /** TLS failed: expired, self-signed or wrong-host certificate. */
  | 'certificate'
  /** No answer: offline, DNS, firewall or (web only) CORS. */
  | 'network'
  | 'timeout'
  /** 401: the key is wrong or was deleted. */
  | 'unauthorized'
  /** 403: the key lacks the permission, the IP is not allowed, or 2FA is required for the account. */
  | 'forbidden'
  | 'notFound'
  /** 409: the server is busy (installing, transferring, restoring) or the action conflicts. */
  | 'conflict'
  /** 400 or 422: the panel rejected the input; `apiMessage` holds its reason. */
  | 'badRequest'
  /** 429: too many requests; the panel throttles. */
  | 'rateLimited'
  /** 502 or 504: the panel could not reach the node's daemon. */
  | 'daemon'
  /** Other 5xx. */
  | 'server'
  /** The answer is not the JSON the endpoint returns. */
  | 'invalidResponse';

export class PanelError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  /** The `detail` of the panel's first error, when it sent one. */
  readonly apiMessage?: string;

  constructor(kind: ErrorKind, message: string, options: { status?: number; apiMessage?: string } = {}) {
    super(message);
    this.name = 'PanelError';
    this.kind = kind;
    this.status = options.status;
    this.apiMessage = options.apiMessage;
  }
}

// What the platforms put into the message of a failed TLS handshake: iOS (NSURLErrorDomain
// -1202 and friends), Android (OkHttp / javax.net.ssl) and the browsers' net::ERR_CERT_* codes.
const CERTIFICATE_PATTERNS = [
  /certificate/i,
  /\bSSL\b/i,
  /\bTLS\b/i,
  /CertPath/i,
  /trust anchor/i,
  /ERR_CERT_/i,
  /-120[0-6]\b/,
  /hostname .* not verified/i,
];

/** Sorts an error thrown by fetch or a socket (not an HTTP status) into a kind. */
export function classifyFetchError(error: unknown): PanelError {
  if (error instanceof PanelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || /timed? ?out/i.test(message)) return new PanelError('timeout', message);
  if (CERTIFICATE_PATTERNS.some((pattern) => pattern.test(message))) return new PanelError('certificate', message);
  return new PanelError('network', message);
}

/** Sorts an HTTP error status into a kind. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 400 || status === 422) return 'badRequest';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rateLimited';
  if (status === 502 || status === 504) return 'daemon';
  if (status >= 500) return 'server';
  return 'invalidResponse';
}

/** The `detail` of the first entry of a panel error body: {"errors":[{"code","status","detail"}]}. */
export function errorDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { detail?: unknown };
    if (typeof first?.detail === 'string') return first.detail;
  }
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}
