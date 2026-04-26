import type { SearchHit, SkillDoc } from "./types";

const OWNER = "anoop22";
const REPO = "onestreamxf-skill";
const BRANCH = "main";

const FALLBACK_FILES = [
  "SKILL.md",
  "0-quick-reference.md",
  "1-conceptual-architecture.md",
  "2-business-rules.md",
  "3-cube-views.md",
  "4-dashboards.md",
  "5-workflow-data-mgmt.md",
  "6-query-patterns.md",
  "7-domain-logic.md",
  "8-cross-references.md",
  "9-retrieval-rules.md",
  "10-public-web-resources.md",
];

const META_DOC_PATHS = new Set(["README.md", "SKILL.md", "9-retrieval-rules.md"]);

type GitHubContent = {
  name: string;
  path: string;
  type: "file" | "dir";
};

export async function loadOneStreamSkill(signal?: AbortSignal): Promise<SkillDoc[]> {
  const files = await listMarkdownFiles(signal).catch(() => FALLBACK_FILES);
  const docs = await Promise.all(
    files.map(async (path) => {
      const url = rawUrl(path);
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`Could not load ${path}: ${response.status}`);
      }
      const content = await response.text();
      return {
        path,
        title: titleFromPath(path, content),
        url: githubUrl(path),
        content,
      };
    }),
  );

  return docs.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

async function listMarkdownFiles(signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/contents?ref=${BRANCH}`,
    { signal, headers: { Accept: "application/vnd.github+json" } },
  );
  if (!response.ok) {
    throw new Error(`GitHub contents request failed: ${response.status}`);
  }

  const items = (await response.json()) as GitHubContent[];
  return items
    .filter((item) => item.type === "file" && item.name.endsWith(".md"))
    .map((item) => item.path);
}

function rawUrl(path: string): string {
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${encodeURIComponentPath(path)}`;
}

function githubUrl(path: string): string {
  return `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${encodeURIComponentPath(path)}`;
}

function encodeURIComponentPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function titleFromPath(path: string, content: string): string {
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (firstHeading) return firstHeading.replace(/`/g, "");
  return path.replace(/\.md$/, "").replace(/^\d+-/, "").replace(/-/g, " ");
}

export function buildSkillOverview(docs: SkillDoc[]): string {
  const skillDoc = docs.find((doc) => doc.path === "SKILL.md");
  const list = docs
    .map((doc) => `- ${doc.path}: ${doc.title} (${doc.url})`)
    .join("\n");

  return [
    "The OneStream XF skill is loaded from the public GitHub repository anoop22/onestreamxf-skill.",
    "Use it as the primary source of OneStream domain guidance.",
    "",
    "Skill entry point:",
    trimForPrompt(stripFrontmatter(skillDoc?.content ?? ""), 2800),
    "",
    "Available skill documents:",
    list,
  ].join("\n");
}

export function searchSkill(docs: SkillDoc[], query: string, maxResults = 5): SearchHit[] {
  return searchDocs(docs, query, maxResults);
}

export function searchAnswerEvidence(docs: SkillDoc[], query: string, maxResults = 5): SearchHit[] {
  const topicalDocs = docs.filter((doc) => !isMetaSkillDoc(doc.path));
  return searchDocs(topicalDocs, query, maxResults);
}

export function isMetaSkillDoc(path: string): boolean {
  return META_DOC_PATHS.has(path);
}

function searchDocs(docs: SkillDoc[], query: string, maxResults = 5): SearchHit[] {
  const normalized = normalize(query);
  const queryTokens = tokenize(query);
  if (!normalized && queryTokens.length === 0) return [];

  const sections = docs.flatMap((doc) => splitIntoSections(doc));
  const scored = sections
    .map((section) => ({
      ...section,
      score: scoreSection(section, normalized, queryTokens),
    }))
    .filter((section) => section.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(maxResults, 8)));

  return scored.map((section) => ({
    path: section.path,
    title: section.title,
    heading: section.heading,
    excerpt: makeExcerpt(section.body, queryTokens),
    score: Math.round(section.score * 10) / 10,
    url: section.url,
  }));
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function trimForPrompt(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars).trim()}\n...`;
}

function splitIntoSectionsForDoc(doc: SkillDoc) {
  const lines = stripFrontmatter(doc.content).split("\n");
  const sections: Array<{ path: string; title: string; heading: string; body: string; url: string }> = [];
  let heading = doc.title;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) {
      sections.push({ path: doc.path, title: doc.title, heading, body, url: doc.url });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[2].replace(/`/g, "").trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return sections;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      normalize(value)
        .replace(/[^a-z0-9_.#]+/g, " ")
        .split(" ")
        .filter((token) => token.length > 2),
    ),
  );
}

function scoreSection(
  section: { path: string; title: string; heading: string; body: string },
  normalizedQuery: string,
  queryTokens: string[],
): number {
  const haystack = normalize(`${section.path} ${section.title} ${section.heading} ${section.body}`);
  const heading = normalize(`${section.path} ${section.title} ${section.heading}`);
  let score = 0;

  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 18;

  for (const token of queryTokens) {
    const occurrences = countOccurrences(haystack, token);
    if (occurrences > 0) score += Math.min(occurrences, 8);
    if (heading.includes(token)) score += 3;
  }

  const identifierTokens = queryTokens.filter((token) => /[._#]/.test(token) || /api|brapi|fdx|cube|view/.test(token));
  for (const token of identifierTokens) {
    if (haystack.includes(token)) score += 5;
  }

  return score;
}

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let index = value.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(token, index + token.length);
  }
  return count;
}

function makeExcerpt(body: string, queryTokens: string[]): string {
  const compact = body.replace(/\s+/g, " ").trim();
  const excerptLimit = 560;
  if (compact.length <= excerptLimit) return compact;

  const lower = compact.toLowerCase();
  const hitIndex = queryTokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (hitIndex === undefined) {
    return `${compact.slice(0, excerptLimit).trim()}...`;
  }

  const start = Math.max(0, hitIndex - 180);
  const end = Math.min(compact.length, start + excerptLimit);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

function splitIntoSections(doc: SkillDoc) {
  return splitIntoSectionsForDoc(doc);
}
