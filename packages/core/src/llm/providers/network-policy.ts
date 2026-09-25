import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export type EndpointLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

export class UnsafeLlmEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeLlmEndpointError';
  }
}

export async function assertSafeLlmEndpoint(
  endpoint: string,
  allowPrivateNetwork: boolean,
  lookup: EndpointLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<void> {
  const url = new URL(endpoint);
  if (url.username || url.password) throw new UnsafeLlmEndpointError('LLM endpoint credentials are not allowed in the URL.');
  if (url.search || url.hash) throw new UnsafeLlmEndpointError('LLM endpoint query strings and fragments are not allowed.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new UnsafeLlmEndpointError('LLM endpoints require HTTPS except for loopback development endpoints.');
  }
  if (allowPrivateNetwork) return;
  if (isLoopbackHost(url.hostname)) throw new UnsafeLlmEndpointError('LLM endpoint resolves to a private network address.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalVersion = net.isIP(hostname);
  const addresses = literalVersion
    ? [{ address: hostname, family: literalVersion }]
    : await lookup(hostname);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new UnsafeLlmEndpointError('LLM endpoint resolves to a private network address.');
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '127.0.0.1' || normalized === '::1';
}

function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  const version = net.isIP(normalized);
  if (version === 4) return isPublicIpv4(normalized);
  if (version !== 6) return false;
  if (normalized === '::' || normalized === '::1') return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  if (normalized.startsWith('::ffff:')) return false;
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xffc0) === 0xfec0) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (normalized.startsWith('2001:db8:')) return false;
  return true;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
