import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import { buildSkillOverview, searchAnswerEvidence } from "./skillLoader";
import type { AppSettings, SearchHit, SkillDoc, WebSearchHit } from "./types";
import { searchPublicWeb } from "./webSearch";

export function createOneStreamAgent(settings: AppSettings, docs: SkillDoc[]): Agent {
  const model = getModel("openrouter", settings.model as never);
  const tools = [createSkillSearchTool(docs), ...(settings.publicWebSearch ? [createPublicWebSearchTool()] : [])];

  return new Agent({
    initialState: {
      model,
      systemPrompt: buildSystemPrompt(docs, settings.publicWebSearch),
      thinkingLevel: settings.thinkingLevel,
      tools,
      messages: [],
    },
    getApiKey: (provider) => {
      if (provider === "openrouter") return settings.apiKey.trim();
      return undefined;
    },
    streamFn: (modelRef, context, options) =>
      streamSimple(modelRef, context, {
        ...options,
        headers: {
          ...(options as { headers?: Record<string, string> } | undefined)?.headers,
          "HTTP-Referer": globalThis.location?.origin ?? "https://anoop22.github.io",
          "X-Title": "OneStream XF Skill Chat",
        },
        timeoutMs: 180_000,
        maxRetries: 1,
      }),
    maxRetryDelayMs: 15_000,
    toolExecution: "sequential",
  });
}

function buildSystemPrompt(docs: SkillDoc[], publicWebSearch: boolean): string {
  return `You are OneStream XF Skill Chat, a careful OneStream XF / OneStream EPM specialist.

You answer questions about OneStream XF, especially Cube Views, Dashboards, Business Rules, BRApi, workflow, Data Management, parameters, data buffers, consolidation, security, and APIs.

Behavior:
- The user should not need to ask for the skill, retrieval, or web search. For every substantive OneStream question, automatically use the loaded skill and the provided public references to ground the answer.
- Treat the loaded onestreamxf skill as your primary reference material. Read the skill context first, then use public web context or public web search to corroborate official documentation, community posts, and vendor references.
- Most user messages include "Skill context" and optionally "Public web context". Treat those sections as mandatory grounding evidence, not as user-visible prose to repeat.
- The app preloads skill hits into the prompt. If those hits are insufficient for the user's exact question, use search_onestream_skill before finalizing the answer.
- Use at most two search_onestream_skill calls per user message: one exact identifier/API query and, only if needed, one broader concept query.
- ${
    publicWebSearch
      ? "Public web search is enabled. The app attempts public web grounding before you answer; use those web hits when present. If the preloaded public web context is missing, weak, or not specific enough, use search_public_web once with exact OneStream terms. Prefer documentation.onestream.com and community.onestreamsoftware.com when relevant."
      : "Public web search is disabled in settings; rely on the loaded skill documents and cite their public links."
  }
- Do not ask the user to add phrases like "use the skill" or "search the web"; this grounding workflow is your responsibility.
- Do not narrate the retrieval process in the final answer unless it clarifies an evidence caveat. Answer the OneStream question directly.
- Do not repeat a failed search with tiny wording changes. If the first two searches are imperfect, synthesize from the best available hits and state the caveat.
- Request no more than 6 search results. Prefer 4 when the query is narrow.
- Synthesize across skill hits instead of parroting a single excerpt.
- Give a complete but concise practical answer: what is supported, what to do next, what to verify, and sources.
- For normal answers, stay under about 450 words unless the user explicitly asks for a deep dive. Prefer a finished short answer over an unfinished long answer.
- Use this default shape when it fits: "Short answer", "What is supported", "What to verify", "Sources".
- Cite the relevant skill documents and public reference links as clickable Markdown links in a short Sources section.
- Never cite internal labels such as "Skill hit 1" or "Web hit 2" in the final answer. Convert those hits into human-readable document names and clickable links.
- Treat public web search snippets as supporting evidence, not authoritative proof of exact method signatures. Verify exact API details against OneStream documentation or the customer's installed version.
- Do not expand a snippet into extra implementation detail. For example, if a hit only says a Cube View Extender Business Rule can apply advanced formatting, do not invent supported events, object members, UI paths, row/column/cell scope, or code mechanics.
- Do not create plausible-sounding OneStream artifacts. If an exact rule type, property, API, object model member, or UI label is not in the retrieved evidence, either omit it or explicitly label it as something to verify.
- Prefer a conservative "I do not have enough evidence for the exact implementation" over an overconfident invented recipe.
- If the skill material does not prove something, say what must be verified in the customer application or OneStream version.
- Never invent exact method signatures, enum values, or BRApi paths when the skill does not support them.

${buildSkillOverview(docs)}`;
}

function createPublicWebSearchTool(): AgentTool<typeof PublicWebSearchParams, { hits: WebSearchHit[] }> {
  return {
    name: "search_public_web",
    label: "Search Public Web",
    description:
      "Search public web results for OneStream documentation, OneStream Community posts, and public vendor references. Uses DuckDuckGo HTML results through a CORS proxy so it can run from GitHub Pages.",
    parameters: PublicWebSearchParams,
    prepareArguments: (args) => {
      const raw = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const query = typeof raw.query === "string" && raw.query.trim() ? raw.query.trim() : "OneStream XF documentation";
      const site = typeof raw.site === "string" && raw.site.trim() ? raw.site.trim() : undefined;
      const maxResults = typeof raw.max_results === "number" ? raw.max_results : Number(raw.max_results);

      return {
        query,
        ...(site ? { site } : {}),
        max_results: clampNumber(Number.isFinite(maxResults) ? maxResults : 4, 1, 5),
      };
    },
    execute: async (_toolCallId, params) => {
      const hits = await searchPublicWeb(params.query, {
        site: params.site,
        maxResults: params.max_results ?? 4,
      });
      const text =
        hits.length === 0
          ? "No public web results were returned. Use the loaded skill results and mention that public corroboration was not found."
          : hits
              .map(
                (hit, index) =>
                  [
                    `Result ${index + 1}: ${hit.title}`,
                    `Source: ${hit.source}`,
                    `URL: ${hit.url}`,
                    `Snippet: ${hit.snippet || "No snippet returned."}`,
                  ].join("\n"),
              )
              .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { hits },
      };
    },
    executionMode: "sequential",
  };
}

function createSkillSearchTool(docs: SkillDoc[]): AgentTool<typeof SkillSearchParams, { hits: SearchHit[] }> {
  return {
    name: "search_onestream_skill",
    label: "Search OneStream Skill",
    description:
      "Search the loaded public OneStream XF skill documents by concept, API name, dashboard/cube-view term, Business Rule pattern, or troubleshooting phrase.",
    parameters: SkillSearchParams,
    prepareArguments: (args) => {
      const raw = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const query = typeof raw.query === "string" && raw.query.trim() ? raw.query.trim() : "OneStream XF";
      const focus = typeof raw.focus === "string" && raw.focus.trim() ? raw.focus.trim() : undefined;
      const maxResults = typeof raw.max_results === "number" ? raw.max_results : Number(raw.max_results);

      return {
        query,
        ...(focus ? { focus } : {}),
        max_results: clampNumber(Number.isFinite(maxResults) ? maxResults : 4, 1, 6),
      };
    },
    execute: async (_toolCallId, params) => {
      const hits = searchAnswerEvidence(docs, [params.query, params.focus].filter(Boolean).join(" "), params.max_results ?? 4);
      const text =
        hits.length === 0
          ? "No matching topical OneStream skill sections were found. Try one broader topic query, use public web search when enabled, or state that the available evidence is insufficient."
          : hits
              .map(
                (hit, index) =>
                  [
                    `Result ${index + 1}: ${hit.title}`,
                    `Document: ${hit.path}`,
                    `Section: ${hit.heading}`,
                    `Source: ${hit.url}`,
                    `Excerpt: ${hit.excerpt}`,
                  ].join("\n"),
              )
              .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { hits },
      };
    },
    executionMode: "sequential",
  };
}

const SkillSearchParams = Type.Object({
  query: Type.String({
    description:
      "The search query. Use exact OneStream identifiers when available, such as FdxExecuteCubeView, Cube View, Dashboard Data Set Business Rule, NameValuePairs, BRApi, or Workflow.",
  }),
  focus: Type.Optional(
    Type.String({
      description: "Optional extra focus area, such as dashboard parameters, cube view data extraction, workflow, or security.",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: "Maximum number of sections to return, from 1 to 6. Default is 4.",
      minimum: 1,
      maximum: 6,
    }),
  ),
});

const PublicWebSearchParams = Type.Object({
  query: Type.String({
    description:
      "A focused public web search query. Include exact OneStream terms, method names, document names, or community-post wording. The tool automatically adds OneStream if missing.",
  }),
  site: Type.Optional(
    Type.String({
      description:
        "Optional domain to restrict the search, such as documentation.onestream.com, community.onestreamsoftware.com, onestream.com, or a public vendor blog domain.",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: "Maximum number of public web results to return, from 1 to 5. Default is 4.",
      minimum: 1,
      maximum: 5,
    }),
  ),
});

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
