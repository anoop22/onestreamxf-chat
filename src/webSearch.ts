import type { WebSearchHit } from "./types";

const DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/";
const ALL_ORIGINS_RAW_URL = "https://api.allorigins.win/raw";
const SEARCH_TIMEOUT_MS = 12_000;

export async function searchPublicWeb(
  query: string,
  options: { site?: string; maxResults?: number } = {},
): Promise<WebSearchHit[]> {
  const searchQuery = buildSearchQuery(query, options.site);
  const target = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(searchQuery)}`;
  const proxiedUrl = `${ALL_ORIGINS_RAW_URL}?url=${encodeURIComponent(target)}`;

  const html = await fetchTextWithTimeout(proxiedUrl);
  return parseDuckDuckGoResults(html).slice(0, clamp(options.maxResults ?? 4, 1, 5));
}

function buildSearchQuery(query: string, site?: string): string {
  const cleanQuery = query.replace(/\s+/g, " ").trim();
  const oneStreamQuery = /\bonestream\b/i.test(cleanQuery) ? cleanQuery : `OneStream ${cleanQuery}`;
  const cleanSite = normalizeSite(site);
  return cleanSite ? `${oneStreamQuery} site:${cleanSite}` : oneStreamQuery;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
