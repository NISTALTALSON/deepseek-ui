import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { ResearchError, defaultResearchLimits, type FetchedPage, type ResearchLimits } from "./types.js";
import {
  isBlockedHostname,
  parseUrl,
  resolvePublicTarget,
  validateResearchUrl,
  type DnsResolver,
} from "./url-safety.js";

// Safe page retrieval.
//
// The fetcher validates every hop (initial URL and each redirect), pins the
// resolved address for the actual socket so a second DNS answer cannot redirect
// the connection, never sends credentials/cookies, bounds response size and
// time, and only decodes textual content. Remote scripts are never executed.

export interface HttpTransportRequest {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}

export interface HttpTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

export interface PageFetcherOptions {
  limits?: Partial<ResearchLimits>;
  transport?: HttpTransport;
  resolve?: DnsResolver;
  now?: () => Date;
  /** Honored only for real network retrieval; disabled for deterministic fixtures. */
  respectRobots?: boolean;
  /** Test-only. Never enable in production. */
  allowPrivateForTests?: boolean;
  allowedPorts?: number[];
  userAgent?: string;
}

const DEFAULT_USER_AGENT = "DeepSeekUI-Research/1.0 (local agent; +https://github.com/NISTALTALSON/deepseek-ui)";
const allowedContentTypes = ["text/html", "application/xhtml+xml", "text/plain"];

const toHeaderRecord = (headers: IncomingHttpHeaders): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
};

/** Default transport: pins the validated address and caps the response size. */
export const nodeHttpTransport: HttpTransport = async (input) => {
  return await new Promise<HttpTransportResponse>((resolve, reject) => {
    const client = input.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = client(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port ? Number(input.url.port) : input.url.protocol === "https:" ? 443 : 80,
        path: `${input.url.pathname}${input.url.search}`,
        method: "GET",
        headers: {
          host: input.url.host,
          ...input.headers,
        },
        signal: input.signal,
        agent: false,
        servername: input.url.hostname,
        // Pin the address that URL validation already approved.
        lookup: (_hostname, _options, callback) => {
          callback(null, input.address, input.family);
        },
      },
      (response) => {
        const headers = toHeaderRecord(response.headers);
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > input.maxBytes) {
            response.destroy(new ResearchError("response_too_large", "Response exceeded the size limit.", {
              maxBytes: input.maxBytes,
            }));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        response.on("error", (error) => {
          reject(
            error instanceof ResearchError
              ? error
              : new ResearchError("network_error", error instanceof Error ? error.message : String(error)),
          );
        });
      },
    );
    request.on("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (input.signal.aborted) {
        reject(new ResearchError("timeout", "Page retrieval was aborted or timed out."));
        return;
      }
      reject(new ResearchError("network_error", error.message, code ? { code } : {}));
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new ResearchError("timeout", "Page retrieval timed out.", { timeoutMs: input.timeoutMs }));
    });
    request.end();
  });
};

export const decodeBody = (body: Buffer, charset: string): string => {
  const normalized = charset.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "utf8": "utf-8",
    "utf-8": "utf-8",
    "iso-8859-1": "iso-8859-1",
    "latin1": "iso-8859-1",
    "us-ascii": "utf-8",
    "windows-1252": "windows-1252",
  };
  const encoding = aliases[normalized] ?? "utf-8";
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(body).replace(/^\ufeff/, "");
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body).replace(/^\ufeff/, "");
  }
};

const contentTypeOf = (headers: Record<string, string>): { mime: string; charset: string } => {
  const raw = headers["content-type"] ?? "text/html";
  const [mimePart, ...params] = raw.split(";");
  const charsetParam = params.find((part) => part.trim().toLowerCase().startsWith("charset="));
  return {
    mime: (mimePart ?? "").trim().toLowerCase(),
    charset: charsetParam ? charsetParam.split("=")[1]!.trim().replace(/["']/g, "") : "utf-8",
  };
};

const isTextual = (mime: string) => allowedContentTypes.some((allowed) => mime === allowed || mime.startsWith(`${allowed};`));

interface RobotsRules {
  disallow: string[];
  allow: string[];
  fetchedAt: number;
}

/** Minimal, cached robots.txt policy: only the `User-agent: *` group is used. */
class RobotsPolicy {
  private cache = new Map<string, RobotsRules | "unavailable">();

  constructor(private readonly fetcher: PageFetcher, private readonly now: () => number) {}

  private async load(origin: string): Promise<RobotsRules | "unavailable"> {
    const cacheKey = origin;
    const cached = this.cache.get(cacheKey);
    if (cached && (cached === "unavailable" || this.now() - cached.fetchedAt < 10 * 60_000)) return cached;
    try {
      const page = await this.fetcher.fetchRaw(new URL("/robots.txt", origin).toString());
      const rules: RobotsRules = { disallow: [], allow: [], fetchedAt: this.now() };
      let applies = false;
      for (const rawLine of page.body.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line) continue;
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const field = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (field === "user-agent") {
          applies = value === "*";
          continue;
        }
        if (!applies) continue;
        if (field === "disallow" && value) rules.disallow.push(value);
        if (field === "allow" && value) rules.allow.push(value);
      }
      this.cache.set(cacheKey, rules);
      return rules;
    } catch {
      this.cache.set(cacheKey, "unavailable");
      return "unavailable";
    }
  }

  async isAllowed(url: URL): Promise<boolean> {
    const rules = await this.load(url.origin);
    if (rules === "unavailable") return true;
    const path = `${url.pathname}${url.search}`;
    const matches = (prefix: string) => path.startsWith(prefix);
    const allowLength = Math.max(0, ...rules.allow.filter(matches).map((prefix) => prefix.length));
    const disallowLength = Math.max(0, ...rules.disallow.filter(matches).map((prefix) => prefix.length));
    return allowLength >= disallowLength;
  }
}

/** Simple per-host gate: at most two in-flight requests and a small spacing delay. */
class HostGate {
  private chain: Promise<void> = Promise.resolve();
  private readonly spacingMs = 200;

  async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await new Promise((resolve) => setTimeout(resolve, this.spacingMs));
      return await task();
    } finally {
      release();
    }
  }
}

export class PageFetcher {
  readonly limits: ResearchLimits;
  private readonly transport: HttpTransport;
  private readonly resolve?: DnsResolver;
  private readonly now: () => number;
  private readonly robots?: RobotsPolicy;
  private readonly allowPrivateForTests: boolean;
  private readonly allowedPorts?: number[];
  private readonly userAgent: string;
  private readonly hostGates = new Map<string, HostGate>();

  constructor(private readonly options: PageFetcherOptions = {}) {
    this.limits = { ...defaultResearchLimits, ...options.limits };
    this.transport = options.transport ?? nodeHttpTransport;
    this.resolve = options.resolve;
    this.now = () => (options.now ? options.now() : new Date()).getTime();
    this.allowPrivateForTests = options.allowPrivateForTests ?? false;
    this.allowedPorts = options.allowedPorts;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    if (options.respectRobots) this.robots = new RobotsPolicy(this, this.now);
  }

  private gate(hostname: string): HostGate {
    let gate = this.hostGates.get(hostname);
    if (!gate) {
      gate = new HostGate();
      this.hostGates.set(hostname, gate);
    }
    return gate;
  }

  /** Internal hop fetch without robots or redirect handling. */
  async fetchRaw(input: string, signal?: AbortSignal): Promise<FetchedPage> {
    return await this.fetchInternal(input, signal, false);
  }

  private async fetchInternal(input: string, signal: AbortSignal | undefined, checkRobots: boolean): Promise<FetchedPage> {
    const limits = this.limits;
    const redirects: string[] = [];
    let current = input;

    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      const validated = this.allowPrivateForTests
        ? await validateResearchUrl(current, { allowPrivateForTests: true, allowedPorts: this.allowedPorts })
        : await validateResearchUrl(current, {
            resolve: this.resolve,
            allowedPorts: this.allowedPorts,
            allowPrivateForTests: false,
          });
      if (checkRobots && this.robots && !(await this.robots.isAllowed(validated.url))) {
        throw new ResearchError("robots_disallowed", "The site's robots.txt disallows this retrieval.", {
          url: current,
        });
      }
      const timeoutSignal = AbortSignal.timeout(limits.fetchTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      if (combined.aborted) {
        throw new ResearchError("timeout", "Page retrieval timed out.", { url: current, timeoutMs: limits.fetchTimeoutMs });
      }
      let response: HttpTransportResponse;
      try {
        response = await this.gate(validated.hostname).run(async () => {
          // The per-host gate can consume the whole timeout budget; never hand an
          // already-aborted signal to a transport that only listens for new aborts.
          if (combined.aborted) {
            throw new ResearchError("timeout", "Page retrieval timed out.", { url: current, timeoutMs: limits.fetchTimeoutMs });
          }
          return this.transport({
            url: validated.url,
            address: validated.address,
            family: validated.family,
            headers: {
              "user-agent": this.userAgent,
              "accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
              "accept-language": "en;q=0.9",
              "cache-control": "no-cache",
            },
            signal: combined,
            timeoutMs: limits.fetchTimeoutMs,
            maxBytes: limits.maxResponseBytes,
          });
        });
      } catch (error) {
        if (error instanceof ResearchError) throw error;
        if (combined.aborted) throw new ResearchError("timeout", "Page retrieval timed out.", { url: current });
        throw new ResearchError("network_error", error instanceof Error ? error.message : String(error), { url: current });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) {
          throw new ResearchError("unsafe_redirect", "Redirect response had no Location header.", { url: current });
        }
        let next: URL;
        try {
          next = new URL(location, validated.url);
        } catch {
          throw new ResearchError("unsafe_redirect", "Redirect target is not a valid URL.", { url: current });
        }
        if (validated.url.protocol === "https:" && next.protocol === "http:") {
          throw new ResearchError("unsafe_redirect", "Redirect downgrades HTTPS to HTTP.", { url: current });
        }
        if (next.username || next.password) {
          throw new ResearchError("unsafe_redirect", "Redirect target contains credentials.", { url: current });
        }
        if (isBlockedHostname(next.hostname)) {
          throw new ResearchError("unsafe_redirect", "Redirect target hostname is blocked.", { url: current });
        }
        // Validate the next hop before following it; this also re-pins DNS.
        try {
          await validateResearchUrl(next.toString(), {
            resolve: this.resolve,
            allowedPorts: this.allowedPorts,
            allowPrivateForTests: this.allowPrivateForTests,
          });
        } catch (error) {
          if (error instanceof ResearchError) {
            throw new ResearchError("unsafe_redirect", `Redirect target rejected: ${error.message}`, {
              url: current,
              target: next.toString(),
              reason: error.code,
            });
          }
          throw error;
        }
        redirects.push(next.toString());
        current = next.toString();
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ResearchError("http_error", `Page returned HTTP ${response.status}.`, {
          url: current,
          status: response.status,
        });
      }

      const { mime, charset } = contentTypeOf(response.headers);
      if (!isTextual(mime)) {
        throw new ResearchError("unsupported_content_type", `Content type ${mime || "unknown"} is not textual.`, {
          url: current,
          contentType: mime,
        });
      }
      if (response.body.byteLength > limits.maxResponseBytes) {
        throw new ResearchError("response_too_large", "Response exceeded the size limit.", {
          url: current,
          maxBytes: limits.maxResponseBytes,
        });
      }
      return {
        url: validated.url.toString(),
        finalUrl: validated.url.toString(),
        status: response.status,
        contentType: mime,
        charset,
        body: decodeBody(response.body, charset),
        byteLength: response.body.byteLength,
        retrievedAt: new Date(this.now()).toISOString(),
        redirects,
      };
    }

    throw new ResearchError("too_many_redirects", "Too many redirects.", {
      url: input,
      maxRedirects: limits.maxRedirects,
    });
  }

  async fetch(input: string, options: { signal?: AbortSignal } = {}): Promise<FetchedPage> {
    parseUrl(input);
    const first = await this.fetchInternal(input, options.signal, Boolean(this.robots));
    // `finalUrl` is the last validated hop; redirects are already listed.
    return first;
  }
}
