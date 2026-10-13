// ============================================================
// Research Tools - keyless read-only research channel schemas
// 资料查询模式（research mode）的检索渠道工具面：schema 与契约在 contracts 集中定义，
// handler 与格式化在 core 的 tool/handlers/research-tools.ts。渠道端点全部免 key、
// 只读 GET；工具名变更时必须同步 packages/shared/src/tool-identity.ts 的 search family。
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import type { ToolContractDeclaration } from "./contract.js";

const RESEARCH_MAX_LIMIT = 20;
const RESEARCH_DEFAULT_LIMIT = 5;

const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(RESEARCH_MAX_LIMIT)
  .optional()
  .describe(
    `Maximum number of results to return (default ${RESEARCH_DEFAULT_LIMIT}, max ${RESEARCH_MAX_LIMIT}).`,
  );

export const SearchDocsInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("Library, framework, or technology name (English works best)."),
    limit: limitSchema,
  })
  .strict();

export const GetLibraryDocsInputSchema = z
  .object({
    libraryId: z
      .string()
      .min(1)
      .describe("Context7 library id from SearchDocs (e.g. '/websites/fastapi_tiangolo')."),
    topic: z
      .string()
      .optional()
      .describe("Optional topic to focus on (e.g. 'middleware', 'authentication')."),
    tokens: z
      .number()
      .int()
      .min(500)
      .max(20000)
      .optional()
      .describe("Approximate maximum response size (default 4000)."),
  })
  .strict();

export const SearchStackOverflowInputSchema = z
  .object({
    query: z.string().min(1).describe("Search query; include the language or error text."),
    limit: limitSchema,
    site: z
      .string()
      .optional()
      .describe(
        "Stack Exchange site id (default 'stackoverflow'). Other sites: superuser, serverfault, math, stats, ai, softwareengineering, ...",
      ),
  })
  .strict();

export const SearchGitHubInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("Repository search query (supports GitHub qualifiers like language:python)."),
    limit: limitSchema,
  })
  .strict();

export const SearchHackerNewsInputSchema = z
  .object({
    query: z.string().min(1).describe("Search query."),
    limit: limitSchema,
  })
  .strict();

export const SearchArxivInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("Paper search query (English). Field prefixes like ti: or abs: restrict to title/abstract."),
    limit: limitSchema,
  })
  .strict();

export const SearchNpmInputSchema = z
  .object({
    query: z.string().min(1).describe("Package name or keyword search."),
    limit: limitSchema,
  })
  .strict();

export const SearchPyPIInputSchema = z
  .object({
    name: z.string().min(1).describe("Exact PyPI package name (e.g. 'httpx')."),
  })
  .strict();

export const SearchMdnInputSchema = z
  .object({
    query: z.string().min(1).describe("API, element, or concept name (e.g. 'ResizeObserver')."),
    limit: limitSchema,
  })
  .strict();

export const SearchPapersInputSchema = z
  .object({
    query: z.string().min(1).describe("Free-text search across titles and abstracts (English)."),
    limit: limitSchema,
  })
  .strict();

export const SearchPubmedInputSchema = z
  .object({
    query: z.string().min(1).describe("Search query (English works best)."),
    limit: limitSchema,
  })
  .strict();

export const ResearchToolOutputSchema = z
  .object({
    result: z.string().min(1).describe("Formatted search results."),
  })
  .strict();

export type ResearchToolOutput = z.infer<typeof ResearchToolOutputSchema>;

export interface ResearchToolSchemaSet {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
}

/** 每个渠道工具的 zod schema 集；key = 工具名（与 core 注册和 tool-identity 保持一致）。 */
export const RESEARCH_TOOL_SCHEMAS: Record<string, ResearchToolSchemaSet> = {
  SearchDocs: { inputSchema: SearchDocsInputSchema, outputSchema: ResearchToolOutputSchema },
  GetLibraryDocs: {
    inputSchema: GetLibraryDocsInputSchema,
    outputSchema: ResearchToolOutputSchema,
  },
  SearchStackOverflow: {
    inputSchema: SearchStackOverflowInputSchema,
    outputSchema: ResearchToolOutputSchema,
  },
  SearchGitHub: { inputSchema: SearchGitHubInputSchema, outputSchema: ResearchToolOutputSchema },
  SearchHackerNews: {
    inputSchema: SearchHackerNewsInputSchema,
    outputSchema: ResearchToolOutputSchema,
  },
  SearchArxiv: { inputSchema: SearchArxivInputSchema, outputSchema: ResearchToolOutputSchema },
  SearchNpm: { inputSchema: SearchNpmInputSchema, outputSchema: ResearchToolOutputSchema },
  SearchPyPI: { inputSchema: SearchPyPIInputSchema, outputSchema: ResearchToolOutputSchema },
  SearchMdn: { inputSchema: SearchMdnInputSchema, outputSchema: ResearchToolOutputSchema },
  SearchPapers: { inputSchema: SearchPapersInputSchema, outputSchema: ResearchToolOutputSchema },
  SearchPubmed: { inputSchema: SearchPubmedInputSchema, outputSchema: ResearchToolOutputSchema },
};

/** 渠道工具共享契约：免 key GET、只读、低风险、免审批（与 WebSearch 同级）。 */
export function makeResearchToolContract(options: {
  name: string;
  capability: string;
}): ToolContractDeclaration {
  return {
    capability: options.capability,
    executionMode: "client",
    inputSchema: toToolJsonSchema(RESEARCH_TOOL_SCHEMAS[options.name]!.inputSchema),
    outputSchema: toToolJsonSchema(RESEARCH_TOOL_SCHEMAS[options.name]!.outputSchema),
    permission: {
      permission: "websearch",
      reason: `${options.name} performs a read-only HTTP GET against a public research API`,
      riskLevel: "low",
      sideEffectScope: "network",
      needsApproval: false,
      patternSources: ["toolName", "network"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: 20_000,
      maxModelBytes: 40_000,
      strategy: "truncate",
      preview: {
        maxLines: 40,
        direction: "head",
      },
    },
    timeout: {
      defaultMs: 30_000,
      maxMs: 60_000,
      allowCallOverride: false,
    },
    cancellation: {
      supported: true,
      cleanup: "bestEffort",
      userVisibleMessage: `${options.name} was cancelled`,
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
  };
}
