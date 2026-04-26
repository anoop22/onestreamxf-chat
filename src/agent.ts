import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple, Type } from "@mariozechner/pi-ai";
import { buildSkillOverview, searchSkill } from "./skillLoader";
import type { AppSettings, SearchHit, SkillDoc } from "./types";

export function createOneStreamAgent(settings: AppSettings, docs: SkillDoc[]): Agent {
  const model = getModel("openrouter", settings.model as never);

  return new Agent({
    initialState: {
      model,
      systemPrompt: buildSystemPrompt(docs),
      thinkingLevel: settings.thinkingLevel,
      tools: [createSkillSearchTool(docs)],
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

function buildSystemPrompt(docs: SkillDoc[]): string {
  return `You are OneStream XF Skill Chat, a careful OneStream XF / OneStream EPM specialist.

You answer questions about OneStream XF, especially Cube Views, Dashboards, Business Rules, BRApi, workflow, Data Management, parameters, data buffers, consolidation, security, and APIs.

Behavior:
- Treat the loaded onestreamxf skill as your primary reference material.
- For OneStream-specific questions, use the search_onestream_skill tool before finalizing the answer.
- For difficult questions, search more than once: use one query for exact API/class/member names and another query for the business concept.
- Synthesize across skill hits instead of parroting a single excerpt.
- Give a complete practical answer: what to do, why, where it runs, pitfalls, and how to validate.
- Cite the relevant skill documents or public reference links when useful.
- If the skill material does not prove something, say what must be verified in the customer application or OneStream version.
- Never invent exact method signatures, enum values, or BRApi paths when the skill does not support them.

${buildSkillOverview(docs)}`;
}

function createSkillSearchTool(docs: SkillDoc[]): AgentTool<typeof SkillSearchParams, { hits: SearchHit[] }> {
  return {
    name: "search_onestream_skill",
    label: "Search OneStream Skill",
    description:
      "Search the loaded public OneStream XF skill documents by concept, API name, dashboard/cube-view term, Business Rule pattern, or troubleshooting phrase.",
    parameters: SkillSearchParams,
    execute: async (_toolCallId, params) => {
      const hits = searchSkill(docs, [params.query, params.focus].filter(Boolean).join(" "), params.max_results ?? 5);
      const text =
        hits.length === 0
          ? "No matching OneStream skill sections were found. Try a broader query or search for exact API/member names."
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
      description: "Maximum number of sections to return, from 1 to 8. Default is 5.",
      minimum: 1,
      maximum: 8,
    }),
  ),
});
