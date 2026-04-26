import type { WebSearchHit } from "./types";

const DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/";
const DUCKDUCKGO_INSTANT_ANSWER_URL = "https://api.duckduckgo.com/";
const ALL_ORIGINS_RAW_URL = "https://api.allorigins.win/raw";
const JINA_READER_PREFIX = "https://r.jina.ai/http://r.jina.ai/http://";
const SEARCH_TIMEOUT_MS = 25_000;
const SEARCH_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "answer",
  "available",
  "before",
  "correct",
  "could",
  "does",
  "dont",
  "enough",
  "exact",
  "evidence",
  "explain",
  "help",
  "invent",
  "please",
  "public",
  "query",
  "reference",
  "search",
  "should",
  "skill",
  "specific",
  "tell",
  "that",
  "this",
  "using",
  "verify",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

export async function searchPublicWeb(
  query: string,
  options: { site?: string; maxResults?: number } = {},
): Promise<WebSearchHit[]> {
  const searchQuery = buildSearchQuery(query, options.site);
  const maxResults = clamp(options.maxResults ?? 4, 1, 5);
  const providers: Array<() => Promise<WebSearchHit[]>> = [
    () => searchDuckDuckGoWithJina(searchQuery),
    () => searchDuckDuckGoWithAllOrigins(searchQuery),
    () => searchDuckDuckGoInstantAnswer(searchQuery),
  ];
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const hits = uniqueHits(await provider());
      if (hits.length > 0) return rankHits(hits).slice(0, maxResults);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) {
    console.warn("Public web search returned no hits.", errors);
  }
  return [];
}

function buildSearchQuery(query: string, site?: string): string {
  const cleanQuery = compactSearchQuery(query);
  const oneStreamQuery = /\bonestream\b/i.test(cleanQuery) ? cleanQuery : `OneStream ${cleanQuery}`;
  const cleanSite = normalizeSite(site);
  return cleanSite ? `${oneStreamQuery} site:${cleanSite}` : oneStreamQuery;
}

async function searchDuckDuckGoWithJina(searchQuery: string): Promise<WebSearchHit[]> {
  const target = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(searchQuery)}`;
  const markdown = await fetchTextWithTimeout(`${JINA_READER_PREFIX}${target}`);
  return parseJinaDuckDuckGoResults(markdown);
}

async function searchDuckDuckGoWithAllOrigins(searchQuery: string): Promise<WebSearchHit[]> {
  const target = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(searchQuery)}`;
  const proxiedUrl = `${ALL_ORIGINS_RAW_URL}?url=${encodeURIComponent(target)}`;
  const html = await fetchTextWithTimeout(proxiedUrl);
  return parseDuckDuckGoResults(html);
}

async function searchDuckDuckGoInstantAnswer(searchQuery: string): Promise<WebSearchHit[]> {
  const url = `${DUCKDUCKGO_INSTANT_ANSWER_URL}?q=${encodeURIComponent(searchQuery)}&format=json&no_redirect=1&no_html=1`;
  const payload = (await fetchJsonWithTimeout(url)) as DuckDuckGoInstantAnswer;
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();

  const addHit = (title: string | undefined, urlValue: string | undefined, snippet: string | undefined) => {
    if (!title || !urlValue || seen.has(urlValue)) return;
    seen.add(urlValue);
    hits.push({
      title: cleanText(title),
      url: urlValue,
      snippet: cleanText(snippet ?? ""),
      source: sourceFromUrl(urlValue),
    });
  };

  addHit(payload.Heading, payload.AbstractURL, payload.AbstractText);
  for (const topic of flattenInstantAnswerTopics([...(payload.Results ?? []), ...(payload.RelatedTopics ?? [])])) {
    addHit(topic.Text?.split(" - ")[0], topic.FirstURL, topic.Text);
  }

  return hits;
}

function compactSearchQuery(query: string): string {
  const compact = query
    .replace(/\bplease\b[\s\S]*$/i, " ")
    .replace(/\bif the evidence\b[\s\S]*$/i, " ")
    .replace(/\busing the onestream skill\b/gi, " ")
    .replace(/\band public web search\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const source = compact || query.replace(/\s+/g, " ").trim() || "OneStream XF";
  const tokens = source.match(/[A-Za-z0-9_.#-]+/g) ?? [];
  const kept: string[] = [];

  for (const token of tokens) {
    const normalized = token.toLowerCase().replace(/[^a-z0-9_.#-]/g, "");
    if (!normalized || SEARCH_STOPWORDS.has(normalized)) continue;
    if (normalized.length < 3 && !/[A-Z]/.test(token) && !/[0-9_.#-]/.test(token)) continue;
    kept.push(token);
    if (kept.length >= 12) break;
  }

  return kept.length > 0 ? kept.join(" ") : source.split(" ").slice(0, 12).join(" ");
}

function normalizeSite(site?: string): string | undefined {
  if (!site) return undefined;
  const cleaned = site
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");

  return cleaned.length > 0 ? cleaned : undefined;
}

async function fetchTextWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/html,text/plain" },
    });
    if (!response.ok) {
      throw new Error(`Public web search failed: ${response.status}`);
    }
    return await response.text();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchJsonWithTimeout(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Public web search failed: ${response.status}`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseDuckDuckGoResults(html: string): WebSearchHit[] {
  const document = new DOMParser().parseFromString(html, "text/html");
  const results = Array.from(document.querySelectorAll(".result"));
  const seen = new Set<string>();

  return results
    .map((result) => {
      const link = result.querySelector<HTMLAnchorElement>("a.result__a");
      if (!link) return undefined;

      const url = decodeDuckDuckGoUrl(link.getAttribute("href") ?? "");
      const title = cleanText(link.textContent ?? "");
      const snippet = cleanText(result.querySelector(".result__snippet")?.textContent ?? "");
      const source = sourceFromUrl(url);

      if (!title || !url || seen.has(url)) return undefined;
      seen.add(url);
      return { title, url, snippet, source };
    })
    .filter((hit): hit is WebSearchHit => Boolean(hit));
}

function parseJinaDuckDuckGoResults(markdown: string): WebSearchHit[] {
  const results: WebSearchHit[] = [];
  const seen = new Set<string>();
  const blocks = markdown.split(/\n## /).slice(1);

  for (const block of blocks) {
    const match = block.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (!match) continue;

    const title = cleanMarkdown(match[1]);
    const url = decodeDuckDuckGoUrl(match[2]);
    if (!title || !url || seen.has(url) || sourceFromUrl(url).includes("duckduckgo.com")) continue;
    seen.add(url);

    const snippet = cleanMarkdown(
      block
        .slice(match[0].length)
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed && !trimmed.startsWith("[![") && !trimmed.startsWith("![") && trimmed !== "[Feedback]";
        })
        .join(" "),
    );

    results.push({
      title,
      url,
      snippet,
      source: sourceFromUrl(url),
    });
  }

  return results;
}

type InstantAnswerTopic = {
  FirstURL?: string;
  Text?: string;
  Topics?: InstantAnswerTopic[];
};

type DuckDuckGoInstantAnswer = {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  Results?: InstantAnswerTopic[];
  RelatedTopics?: InstantAnswerTopic[];
};

function flattenInstantAnswerTopics(topics: InstantAnswerTopic[]): InstantAnswerTopic[] {
  return topics.flatMap((topic) => (topic.Topics ? flattenInstantAnswerTopics(topic.Topics) : [topic]));
}

function decodeDuckDuckGoUrl(href: string): string {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.href;
  } catch {
    return href;
  }
}

function sourceFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanMarkdown(value: string): string {
  return cleanText(
    value
      .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/&amp;/g, "&"),
  );
}

function uniqueHits(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = hit.url || hit.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankHits(hits: WebSearchHit[]): WebSearchHit[] {
  return [...hits].sort((a, b) => hitRank(b) - hitRank(a));
}

function hitRank(hit: WebSearchHit): number {
  const host = hit.source.toLowerCase();
  if (host === "documentation.onestream.com") return 40;
  if (host === "community.onestreamsoftware.com") return 35;
  if (host.endsWith("onestream.com")) return 25;
  if (host === "github.com" && hit.url.includes("anoop22/onestreamxf-skill")) return -10;
  if (host.includes("blackdiamondadvisory.com") || host.includes("perficient.com") || host.includes("mindstreamanalytics.com")) {
    return 15;
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
