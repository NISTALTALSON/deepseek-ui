import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ResearchError } from "./types.js";

// URL/SSRF validation for the research fetcher.
//
// Rules:
// - http/https only, no embedded credentials, bounded length.
// - Only ports 80/443 by default.
// - Local, loopback, link-local, private, CGNAT, multicast, reserved, and
//   documentation ranges are rejected for IPv4 and IPv6 (including IPv4-mapped
//   IPv6 and NAT64 forms).
// - Hostnames are resolved once, every address must be public, and the caller
//   pins one validated address for the actual connection so a second DNS
//   answer (rebinding) is never used.

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface UrlValidationOptions {
  allowedPorts?: number[];
  resolve?: DnsResolver;
  /**
   * Test-only escape hatch. Production callers must never enable it: it makes
   * loopback/private destinations reachable.
   */
  allowPrivateForTests?: boolean;
}

export interface ValidatedUrl {
  url: URL;
  hostname: string;
  port: number;
  /** Pinned address used for the connection. */
  address: string;
  family: number;
  /** True when the destination was a literal IP and no DNS lookup ran. */
  literal: boolean;
}

const defaultPorts = [80, 443];
const maxUrlLength = 2048;

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
  "host.docker.internal",
  "gateway.docker.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

const blockedHostSuffixes = [".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".lan"];

const resolveDns: DnsResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family }));
};

export const parseUrl = (input: string): URL => {
  if (typeof input !== "string" || !input.trim()) {
    throw new ResearchError("invalid_url", "A URL is required.");
  }
  if (input.length > maxUrlLength) {
    throw new ResearchError("invalid_url", "URL is too long.", { length: input.length, max: maxUrlLength });
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ResearchError("invalid_url", "URL could not be parsed.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ResearchError("unsupported_protocol", "Only http and https URLs are supported.", { protocol: url.protocol });
  }
  if (url.username || url.password) {
    throw new ResearchError("credentials_in_url", "URLs containing credentials are not allowed.");
  }
  if (!url.hostname) {
    throw new ResearchError("invalid_url", "URL has no hostname.");
  }
  return url;
};

const ipv4Bytes = (address: string): number[] | null => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
};

/** Expands an IPv6 literal into 16 bytes; returns null when malformed. */
export const ipv6Bytes = (address: string): number[] | null => {
  let input = address;
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  if (!input.includes(":")) return null;
  const halves = input.split("::");
  if (halves.length > 2) return null;

  const expand = (part: string): string[] => (part ? part.split(":") : []);
  let left = expand(halves[0] ?? "");
  let right = halves.length === 2 ? expand(halves[1] ?? "") : [];

  const last = (chunks: string[]) => chunks.at(-1);
  const lastLeft = last(left);
  if (lastLeft && lastLeft.includes(".")) {
    const v4 = ipv4Bytes(lastLeft);
    if (!v4) return null;
    const replaced = `${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
    left = [...left.slice(0, -1), ...replaced.split(":")];
  }
  const lastRight = last(right);
  if (lastRight && lastRight.includes(".")) {
    const v4 = ipv4Bytes(lastRight);
    if (!v4) return null;
    const replaced = `${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
    right = [...right.slice(0, -1), ...replaced.split(":")];
  }

  const missing = 8 - (left.length + right.length);
  if (halves.length === 2 && missing < 0) return null;
  const chunks = halves.length === 2 ? [...left, ...Array(Math.max(0, missing)).fill("0"), ...right] : left;
  if (chunks.length !== 8) return null;
  const bytes: number[] = [];
  for (const chunk of chunks) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
    const value = Number.parseInt(chunk, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
};

/** True for addresses that must never be fetched by the research engine. */
export const isBlockedAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    const bytes = ipv4Bytes(address);
    if (!bytes) return true;
    const [a, b, c] = bytes as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // reserved / TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  if (version === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    const zeroPrefix = (length: number) => bytes.slice(0, length).every((byte) => byte === 0);
    const allZero = bytes.every((byte) => byte === 0);
    if (allZero) return true; // ::
    if (zeroPrefix(15) && bytes[15] === 1) return true; // ::1
    // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96
    if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isBlockedAddress(bytes.slice(12).join("."));
    }
    if (zeroPrefix(12)) {
      const embedded = bytes.slice(12).join(".");
      return embedded === "0.0.0.0" || isBlockedAddress(embedded);
    }
    if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (bytes[0] === 0xff) return true; // ff00::/8 multicast
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo 2001::/32
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true; // NAT64 64:ff9b::/96
    return false;
  }
  return true;
};

export const isBlockedHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (blockedHostnames.has(host)) return true;
  if (blockedHostSuffixes.some((suffix) => host.endsWith(suffix))) return true;
  // Single-label intranet names are not public destinations.
  if (!host.includes(".") && isIP(host) === 0) return true;
  return false;
};

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/\.$/, "");

/** Resolves a hostname once and returns a pinned public address. */
export const resolvePublicTarget = async (
  hostname: string,
  resolver: DnsResolver = resolveDns,
): Promise<{ address: string; family: number }> => {
  const host = normalizeHostname(hostname);
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new ResearchError("private_address", "Destination address is not public.", { hostname: host });
    }
    return { address: host, family: isIP(host) };
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await resolver(host);
  } catch (error) {
    throw new ResearchError("dns_failure", "Hostname could not be resolved.", {
      hostname: host,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!answers.length) {
    throw new ResearchError("dns_failure", "Hostname did not resolve to any address.", { hostname: host });
  }
  const blocked = answers.filter((answer) => isBlockedAddress(answer.address));
  if (blocked.length) {
    throw new ResearchError("private_address", "Hostname resolves to a non-public address.", {
      hostname: host,
      addresses: blocked.map((answer) => answer.address),
    });
  }
  // Prefer IPv4 for broad compatibility but pin exactly one validated answer.
  const chosen = answers.find((answer) => answer.family === 4) ?? answers[0]!;
  return { address: chosen.address, family: chosen.family };
};

export const validateResearchUrl = async (
  input: string,
  options: UrlValidationOptions = {},
): Promise<ValidatedUrl> => {
  const url = parseUrl(input);
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new ResearchError("blocked_host", "Hostname is blocked for research retrieval.", { hostname });
  }
  const allowedPorts = options.allowedPorts ?? defaultPorts;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new ResearchError("blocked_port", "Port is not allowed for research retrieval.", { port, allowedPorts });
  }
  if (options.allowPrivateForTests) {
    const literal = isIP(hostname) !== 0;
    return {
      url,
      hostname,
      port,
      address: literal ? hostname : "93.184.216.34",
      family: literal ? isIP(hostname) : 4,
      literal,
    };
  }
  const pinned = await resolvePublicTarget(hostname, options.resolve ?? resolveDns);
  return { url, hostname, port, address: pinned.address, family: pinned.family, literal: isIP(hostname) !== 0 };
};

/** Removes fragments and common tracking parameters for stable de-duplication. */
export const normalizeUrlForDedupe = (input: string): string => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.trim();
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  const tracking = [
    /^utm_/i, /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i, /^mc_cid$/i, /^mc_eid$/i,
    /^igshid$/i, /^ref_src$/i, /^ref_url$/i, /^spm$/i, /^yclid$/i, /^_hsenc$/i, /^_hsmi$/i,
  ];
  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!tracking.some((pattern) => pattern.test(key))) kept.push([key, value]);
  }
  const query = new URLSearchParams(kept).toString();
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ""}`;
};

export const domainOf = (input: string): string => {
  try {
    return new URL(input).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
