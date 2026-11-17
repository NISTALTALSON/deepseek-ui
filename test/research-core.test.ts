import { test } from "node:test";
import assert from "node:assert/strict";
import { mockPages } from "../src/research/fixtures.js";
import { extractPage } from "../src/research/extract.js";
import {
  isBlockedAddress,
  normalizeUrlForDedupe,
  validateResearchUrl,
} from "../src/research/url-safety.js";
import { PageFetcher, type HttpTransport } from "../src/research/fetcher.js";
import { LocalMockSearchProvider } from "../src/research/providers/mock.js";
import { TavilySearchProvider } from "../src/research/providers/tavily.js";
import { resolveSearchProvider } from "../src/research/search.js";
import { ResearchError } from "../src/research/types.js";

const expectCode = async (operation: Promise<unknown>, code: string) => {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ResearchError, `expected ResearchError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const transport = (handler: (url: URL) => { status: number; headers?: Record<string, string>; body?: string }): HttpTransport =>
  async (request) => {
    const result = handler(request.url);
    return {
      status: result.status,
      headers: result.headers ?? { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(result.body ?? ""),
    };
  };

test("url safety rejects private, loopback, and metadata destinations", async () => {
  for (const url of [
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
    "http://localhost/",
    "http://service.internal/",
  ]) {
    await assert.rejects(validateResearchUrl(url), (error: unknown) => {
      assert.ok(error instanceof ResearchError);
      assert.ok(["private_address", "blocked_host"].includes(error.code), `unexpected code ${error.code} for ${url}`);
      return true;
    });
  }
});

test("url safety blocks unsafe schemes, credentials, and ports", async () => {
  await expectCode(validateResearchUrl("ftp://example.com/file"), "unsupported_protocol");
  await expectCode(validateResearchUrl("file:///etc/passwd"), "unsupported_protocol");
  await expectCode(validateResearchUrl("https://user:pass@example.com/"), "credentials_in_url");
  await expectCode(validateResearchUrl("https://example.com:8443/"), "blocked_port");
});

test("url safety rejects DNS answers that include any private address", async () => {
  await expectCode(
    validateResearchUrl("https://public.example/", {
      resolve: async () => [{ address: "10.0.0.9", family: 4 }],
    }),
    "private_address",
  );
  await expectCode(
    validateResearchUrl("https://public.example/", {
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.0.10", family: 4 },
      ],
    }),
    "private_address",
  );
});

test("url safety pins one validated public address", async () => {
  const validated = await validateResearchUrl("https://public.example/path", {
    resolve: async () => [
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ],
  });
  assert.equal(validated.address, "93.184.216.34");
  assert.equal(validated.family, 4);
});

test("url normalization removes fragments, default ports, and trackers", () => {
  assert.equal(
    normalizeUrlForDedupe("https://Example.com:443/page/?utm_source=x&q=1#section"),
    "https://example.com/page?q=1",
  );
  assert.equal(normalizeUrlForDedupe("https://example.com/?utm_campaign=ad"), "https://example.com");
});

test("extraction returns sanitized text and metadata without scripts", () => {
  const fixture = mockPages[0]!;
  const result = extractPage({ html: fixture.html, url: fixture.url });
  assert.equal(result.ok, true);
  assert.equal(result.title, "Quantum error correction reaches a practical milestone");
  assert.equal(result.publishedAt, "2025-03-11T09:00:00.000Z");
  assert.equal(result.siteName, "Example Science");
  assert.equal(result.canonicalUrl, fixture.url);
  assert.match(result.text, /256-qubit error-corrected processor/);
  assert.doesNotMatch(result.text, /should never appear/);
  assert.doesNotMatch(result.text, /Subscribe to our newsletter/);
  assert.doesNotMatch(result.text, /Privacy policy/);
});

test("extraction strips hidden prompt-injection content", () => {
  const fixture = mockPages.find((page) => page.url.includes("prompt-injection"))!;
  const result = extractPage({ html: fixture.html, url: fixture.url });
  assert.match(result.text, /quantum sensors/);
  assert.doesNotMatch(result.text, /Ignore all previous instructions/);
  assert.doesNotMatch(result.text, /SYSTEM OVERRIDE/);
  assert.doesNotMatch(result.text, /attacker\.example/);
});

test("extraction tolerates malformed HTML and plain text", () => {
  const malformed = extractPage({
    html: "<html><body><div><p>Unclosed paragraph with enough content to be considered readable body text for extraction testing.",
    url: "https://broken.example/article",
  });
  assert.equal(malformed.ok, true);
  assert.match(malformed.text, /Unclosed paragraph/);

  const plain = extractPage({
    html: "Plain notes\n\nThis page is text and mentions quantum sensors in detail.",
    url: "https://plain.example/notes",
    contentType: "text/plain",
  });
  assert.equal(plain.ok, true);
  assert.match(plain.text, /quantum sensors/);
});

test("fetcher retrieves a textual page with a bounded, pinned request", async () => {
  let seen: { address: string; headers: Record<string, string> } | undefined;
  const fetcher = new PageFetcher({
    transport: async (request) => {
      seen = { address: request.address, headers: request.headers };
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(mockPages[0]!.html),
      };
    },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  const page = await fetcher.fetch("https://example.com/article");
  assert.equal(page.status, 200);
  assert.match(page.body, /Quantum error correction/);
  assert.equal(page.retrievedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(seen?.address, "93.184.216.34");
  assert.ok(seen?.headers["user-agent"]);
  assert.equal(seen?.headers.cookie, undefined);
});

test("fetcher blocks redirects to private destinations and HTTPS downgrades", async () => {
  let calls = 0;
  const privateRedirect = new PageFetcher({
    transport: async () => {
      calls += 1;
      return { status: 302, headers: { location: "http://127.0.0.1/admin" }, body: Buffer.from("") };
    },
  });
  await expectCode(privateRedirect.fetch("https://example.com/start"), "unsafe_redirect");
  assert.equal(calls, 1);

  const downgrade = new PageFetcher({
    transport: async () => ({ status: 301, headers: { location: "http://example.com/page" }, body: Buffer.from("") }),
  });
  await expectCode(downgrade.fetch("https://example.com/start"), "unsafe_redirect");
});

test("fetcher enforces redirect limits and rejects non-text responses", async () => {
  let hop = 0;
  const loop = new PageFetcher({
    limits: { maxRedirects: 2 },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => {
      hop += 1;
      return { status: 302, headers: { location: "/again" }, body: Buffer.from("") };
    },
  });
  await expectCode(loop.fetch("https://example.com/start"), "too_many_redirects");
  assert.equal(hop, 3);

  const pdf = new PageFetcher({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: transport(() => ({ status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" })),
  });
  await expectCode(pdf.fetch("https://example.com/doc.pdf"), "unsupported_content_type");
});

test("fetcher rejects oversized bodies and surfaces HTTP errors", async () => {
  const oversized = new PageFetcher({
    limits: { maxResponseBytes: 32 },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: transport(() => ({ status: 200, body: "x".repeat(100) })),
  });
  await expectCode(oversized.fetch("https://example.com/big"), "response_too_large");

  const failing = new PageFetcher({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: transport(() => ({ status: 503, body: "unavailable" })),
  });
  await expectCode(failing.fetch("https://example.com/down"), "http_error");
});

test("fetcher honors robots.txt disallow rules for live retrieval", async () => {
  const fetcher = new PageFetcher({
    respectRobots: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: transport((url) =>
      url.pathname === "/robots.txt"
        ? { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private\n" }
        : { status: 200, body: "<html><body><p>public</p></body></html>" },
    ),
  });
  await expectCode(fetcher.fetch("https://example.com/private/page"), "robots_disallowed");
  const allowed = await fetcher.fetch("https://example.com/public/page");
  assert.equal(allowed.status, 200);
});

test("fetcher aborts slow transports", async () => {
  const fetcher = new PageFetcher({
    limits: { fetchTimeoutMs: 25 },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) =>
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  await expectCode(fetcher.fetch("https://example.com/slow"), "timeout");
});

test("mock search is deterministic, labeled, and paginated", async () => {
  const provider = new LocalMockSearchProvider();
  const first = await provider.search({ query: { text: "quantum error correction" } });
  const second = await provider.search({ query: { text: "quantum error correction" } });
  assert.equal(first.isMock, true);
  assert.equal(first.provider, "local-mock");
  assert.deepEqual(first.results.map((result) => result.url), second.results.map((result) => result.url));
  assert.ok(first.results.length >= 2);
  assert.ok(first.results.every((result) => result.isMock));

  const page = await provider.search({ query: { text: "quantum" }, pageSize: 1 });
  assert.equal(page.results.length, 1);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextPage);
  const next = await provider.search({ query: { text: "quantum" }, pageSize: 1, cursor: page.nextPage });
  assert.notEqual(next.results[0]?.url, page.results[0]?.url);
});

test("tavily adapter maps results and never leaks credentials", async () => {
  const provider = new TavilySearchProvider({
    apiKey: "secret-key-value",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: "Result", url: "https://example.com/a", content: "Snippet", score: 0.9, published_date: "2025-01-02T00:00:00Z" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  const result = await provider.search({ query: { text: "example" } });
  assert.equal(result.isMock, false);
  assert.equal(result.results[0]?.title, "Result");
  assert.equal(result.results[0]?.publishedAt, "2025-01-02T00:00:00.000Z");

  const failing = new TavilySearchProvider({
    apiKey: "secret-key-value",
    fetchImpl: async () => new Response("provider says no", { status: 500 }),
  });
  await assert.rejects(failing.search({ query: { text: "example" } }), (error: unknown) => {
    assert.ok(error instanceof ResearchError);
    assert.equal(error.code, "provider_error");
    assert.doesNotMatch(error.message, /secret-key-value/);
    assert.doesNotMatch(JSON.stringify(error.details), /secret-key-value/);
    return true;
  });
});

test("provider registry honestly reports mock fallback and missing credentials", () => {
  const previousKey = process.env.TAVILY_API_KEY;
  const previousProvider = process.env.RESEARCH_PROVIDER;
  delete process.env.TAVILY_API_KEY;
  delete process.env.RESEARCH_PROVIDER;
  try {
    const auto = resolveSearchProvider({});
    assert.equal(auto.provider.id, "local-mock");
    assert.match(auto.note, /local fixtures/i);

    const missing = resolveSearchProvider({ provider: "tavily" });
    assert.equal(missing.provider.status().available, false);
    assert.equal(missing.degraded, true);

    const explicit = new TavilySearchProvider({ apiKey: "" });
    assert.equal(explicit.status().available, false);
  } finally {
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.RESEARCH_PROVIDER;
    else process.env.RESEARCH_PROVIDER = previousProvider;
  }
});
