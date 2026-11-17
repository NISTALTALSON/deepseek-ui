// Small deterministic text helpers shared by the search adapters and workflow.

export const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did",
  "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into", "is",
  "it", "its", "me", "my", "of", "on", "or", "our", "should", "so", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
  "about", "after", "before", "between", "during", "over", "under", "up", "down", "out",
  "also", "any", "all", "more", "most", "some", "such", "only", "very", "just", "not",
]);

export const tokenize = (input: string): string[] => {
  const normalized = input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
};

export const uniqueTokens = (input: string): string[] => [...new Set(tokenize(input))];

/** Top keywords by frequency, preserving first-seen order for determinism. */
export const extractKeywords = (input: string, limit = 6): string[] => {
  const tokens = tokenize(input);
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  tokens.forEach((token, index) => {
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if (!firstSeen.has(token)) firstSeen.set(token, index);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .slice(0, limit)
    .map(([token]) => token);
};

const normalizeTitle = (input: string): string =>
  input.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export const titleSimilarity = (a: string, b: string): number => {
  const left = new Set(tokenize(normalizeTitle(a)));
  const right = new Set(tokenize(normalizeTitle(b)));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
};

/** 0..1 coverage of the query by the text, with light length normalization. */
export const relevance = (query: string, text: string): number => {
  const queryTokens = uniqueTokens(query);
  if (!queryTokens.length) return 0;
  const textTokens = new Set(tokenize(text));
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      hits += 1;
      continue;
    }
    // Cheap stemming: allow a shared 5-character prefix for longer words.
    if (token.length >= 6 && [...textTokens].some((candidate) => candidate.length >= 6 && candidate.slice(0, 5) === token.slice(0, 5))) {
      hits += 0.5;
    }
  }
  return Math.min(1, hits / queryTokens.length);
};

export interface NumericClaim {
  value: number;
  raw: string;
  unit: string;
}

const UNIT_PATTERN = "(?:%|percent|qubits?|million|billion|trillion|years?|months?|days?|hours?|minutes?|seconds?|ms|gb|tb|ghz|mhz|km|kilometers?|miles?|celsius|°c)";

/** Extracts explicit number+unit claims used for conflict detection. */
export const numericClaims = (text: string): NumericClaim[] => {
  const pattern = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[\\s-]*(${UNIT_PATTERN})(?![a-z])`, "gi");
  const claims: NumericClaim[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const value = Number(match[1]!.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    claims.push({ value, raw: match[0]!, unit: match[2]!.toLowerCase() });
  }
  return claims;
};
