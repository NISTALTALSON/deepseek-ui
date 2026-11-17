import type { PageExtraction } from "./types.js";

// Readability-style extraction with no remote code execution and no HTML in the
// output. Only plain, sanitized text is returned; scripts and styles are
// removed before any other processing so hidden instructions in comments or
// <script> bodies cannot reach the model.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", ldquo: "“",
  rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", bull: "•", deg: "°", euro: "€",
  pound: "£", yen: "¥", sect: "§", para: "¶", times: "×", divide: "÷", plusmn: "±",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", micro: "µ", alpha: "α",
  beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ", mu: "μ", pi: "π",
  sigma: "σ", omega: "ω", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
  uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", ntilde: "ñ", iexcl: "¡", iquest: "¿",
};

export const decodeHtmlEntities = (input: string): string =>
  input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? NAMED_ENTITIES[entity] ?? match;
  });

const stripNul = (value: string) => value.replace(/\u0000/g, "");

/**
 * Sanitizes plain text: removes control characters, zero-width joiners and
 * bidirectional overrides (which can be abused to disguise prompt injection),
 * then normalizes whitespace and enforces a hard character budget.
 */
export const sanitizePlainText = (input: string, maxChars = Number.POSITIVE_INFINITY): string => {
  const withoutControls = stripNul(input)
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
  const lines = withoutControls
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^[\s|·•\-–—_=*#~<>]+$/.test(line));
  const text = lines.join("\n").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
};

const parseAttributes = (source: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    attributes[match[1]!.toLowerCase()] = decodeHtmlEntities(match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attributes;
};

const HIDDEN_ATTRIBUTE = /(?:^|\s)(?:style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["']|\bhidden\b)/i;

const stripHiddenElements = (html: string): string => {
  let output = html;
  for (const tag of ["span", "div", "p", "section", "font", "small", "em", "strong", "b", "i"]) {
    const pattern = new RegExp(`<${tag}\\b([^>]*)>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    output = output.replace(pattern, (match, attributes: string) => (HIDDEN_ATTRIBUTE.test(attributes) ? " " : match));
  }
  return output;
};

const removeDangerousElements = (html: string): string =>
  stripHiddenElements(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed|applet|form|input|select|textarea|button|dialog|canvas|audio|video|source|track)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|embed|applet|form|input|select|textarea|button|dialog|canvas|audio|video|source|track)\b[^>]*\/?>/gi, " ");

const META_PATTERN = /<meta\b([^>]*?)\/?>/gi;

interface MetaInfo {
  values: Map<string, string>;
  title?: string;
  canonical?: string;
  publishedAt?: string;
  siteName?: string;
  description?: string;
}

const readMeta = (html: string, url: string): MetaInfo => {
  const values = new Map<string, string>();
  for (let match = META_PATTERN.exec(html); match; match = META_PATTERN.exec(html)) {
    const attributes = parseAttributes(match[1] ?? "");
    const key = (attributes.property ?? attributes.name ?? attributes.itemprop ?? "").toLowerCase();
    const content = attributes.content?.trim();
    if (key && content && !values.has(key)) values.set(key, content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const h1Tag = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.trim();
  const canonicalTag = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(html)?.[0];
  const canonicalHref = canonicalTag ? parseAttributes(canonicalTag.replace(/^<link/i, "")).href : undefined;

  const first = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = values.get(key);
      if (value) return value;
    }
    return undefined;
  };

  const rawTitle =
    first(["og:title", "twitter:title", "title"]) ??
    (titleTag ? decodeHtmlEntities(titleTag) : undefined) ??
    (h1Tag ? sanitizePlainText(decodeHtmlEntities(h1Tag.replace(/<[^>]+>/g, " ")), 300) : undefined);
  const title = rawTitle ? sanitizePlainText(decodeHtmlEntities(rawTitle), 300) : undefined;

  let canonical: string | undefined;
  if (canonicalHref) {
    try {
      const resolved = new URL(canonicalHref, url);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") canonical = resolved.toString();
    } catch {
      canonical = undefined;
    }
  }
  if (!canonical) {
    try {
      canonical = new URL(url).toString();
    } catch {
      canonical = undefined;
    }
  }

  const dateCandidates = [
    "article:published_time",
    "article:published",
    "og:published_time",
    "datepublished",
    "publish-date",
    "pubdate",
    "publication_date",
    "citation_publication_date",
    "dc.date.issued",
    "dc.date",
    "date",
  ].map((key) => values.get(key));
  const timeTag = /<time\b[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*>/i.exec(html)?.[1];
  if (timeTag) dateCandidates.push(timeTag);

  return {
    values,
    title,
    canonical,
    publishedAt: firstValidDate(dateCandidates),
    siteName: first(["og:site_name", "application-name", "twitter:site", "publisher"]),
    description: first(["og:description", "twitter:description", "description"]),
  };
};

export const firstValidDate = (candidates: Array<string | undefined>): string | undefined => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!/^\d{4}-\d{2}(-\d{2})?([T\s].*)?$/.test(trimmed) && !/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(trimmed)) continue;
    const time = Date.parse(trimmed);
    if (!Number.isFinite(time)) continue;
    const year = new Date(time).getUTCFullYear();
    if (year < 1970 || year > new Date().getUTCFullYear() + 1) continue;
    return new Date(time).toISOString();
  }
  return undefined;
};

interface JsonLdHints {
  publishedAt?: string;
  title?: string;
  siteName?: string;
}

const readJsonLd = (html: string): JsonLdHints => {
  const hints: JsonLdHints = {};
  const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const raw = match[1]?.trim();
    if (!raw || raw.length > 200_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const visit = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== "object" || depth > 4) return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 20)) visit(item, depth + 1);
        return;
      }
      const object = value as Record<string, unknown>;
      if (!hints.publishedAt && typeof object.datePublished === "string") {
        hints.publishedAt = firstValidDate([object.datePublished]);
      }
      if (!hints.title && typeof object.headline === "string") {
        hints.title = sanitizePlainText(object.headline, 300);
      }
      if (!hints.siteName && typeof object.publisher === "object" && object.publisher) {
        const publisher = object.publisher as Record<string, unknown>;
        if (typeof publisher.name === "string") hints.siteName = sanitizePlainText(publisher.name, 120);
      }
      visit(object["@graph"], depth + 1);
    };
    visit(parsed);
  }
  return hints;
};

const BLOCK_TAGS = [
  "p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "ul", "ol",
  "li", "table", "tr", "td", "th", "blockquote", "pre", "figure", "figcaption", "address",
  "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "hr", "br",
];

const htmlToText = (fragment: string): string => {
  let text = fragment;
  for (const tag of BLOCK_TAGS) {
    text = text.replace(new RegExp(`</?${tag}\\b[^>]*>`, "gi"), "\n");
  }
  text = text.replace(/<[^>]+>/g, " ");
  return sanitizePlainText(decodeHtmlEntities(text));
};

const selectMainRegion = (html: string): string => {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((match) => match[1] ?? "");
  if (articles.length) {
    return articles.sort((a, b) => htmlToText(b).length - htmlToText(a).length)[0]!;
  }
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1];
  if (main && htmlToText(main).length > 200) return main;
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1];
  return body ?? html;
};

const BOILERPLATE = /^(cookie(s)?\b|we use cookies|accept (all )?cookies|subscribe\b|sign (in|up)\b|log in\b|advertisement|share this|related (articles|posts|reading)|skip to (content|main)|menu\b|search\b|follow us|newsletter|privacy policy|terms of (service|use)|all rights reserved)/i;

const cleanLines = (text: string): string => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (BOILERPLATE.test(trimmed) && trimmed.length < 160) continue;
    if (seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    lines.push(trimmed);
  }
  return lines.join("\n");
};

const excerptOf = (text: string, limit: number): string => {
  const paragraph = text.split("\n").find((line) => line.length >= 80) ?? text;
  const compact = paragraph.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit).trimEnd()}…` : compact;
};

export interface ExtractPageInput {
  html: string;
  url: string;
  contentType?: string;
  maxChars?: number;
  excerptChars?: number;
}

/** Extracts sanitized text and metadata from an HTML or text/plain page. */
export const extractPage = (input: ExtractPageInput): PageExtraction => {
  const maxChars = input.maxChars ?? 20_000;
  const excerptChars = input.excerptChars ?? 600;
  const contentType = input.contentType ?? "text/html";
  const base = {
    ok: false,
    title: "",
    text: "",
    excerpt: "",
    contentLength: 0,
  } satisfies PageExtraction;

  if (contentType.toLowerCase().startsWith("text/plain")) {
    const text = sanitizePlainText(input.html, maxChars);
    const firstLine = text.split("\n").find((line) => line.trim().length > 3)?.trim() ?? "";
    return {
      ...base,
      ok: text.length >= 20,
      title: firstLine.slice(0, 200) || domainTitle(input.url),
      text,
      excerpt: excerptOf(text, excerptChars),
      contentLength: text.length,
      error: text.length >= 20 ? undefined : "empty_extraction",
    };
  }

  const meta = readMeta(input.html, input.url);
  const jsonLd = readJsonLd(input.html);
  const cleaned = removeDangerousElements(input.html);
  const region = selectMainRegion(cleaned);
  const text = cleanLines(htmlToText(region));
  const fallbackText = text.length < 50 ? cleanLines(htmlToText(cleaned)) : text;
  const title =
    meta.title ??
    jsonLd.title ??
    sanitizePlainText(decodeHtmlEntities(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cleaned)?.[1]?.replace(/<[^>]+>/g, " ") ?? ""), 300) ??
    domainTitle(input.url);

  const ok = fallbackText.length >= 50;
  return {
    ...base,
    ok,
    title: title || domainTitle(input.url),
    siteName: meta.siteName ?? jsonLd.siteName,
    description: meta.description ? sanitizePlainText(meta.description, 400) : undefined,
    canonicalUrl: meta.canonical ?? input.url,
    publishedAt: meta.publishedAt ?? jsonLd.publishedAt,
    text: sanitizePlainText(fallbackText, maxChars),
    excerpt: excerptOf(fallbackText, excerptChars),
    contentLength: fallbackText.length,
    error: ok ? undefined : "empty_extraction",
  };
};

const domainTitle = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Untitled page";
  }
};
