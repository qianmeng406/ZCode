// ============================================================
// Research Tools — keyless read-only research channels
// 资料查询模式（research mode）的检索渠道实现。移植自早期 deepagents 原型
// （research_tools.py），端点全部免 key、只读 GET；出网统一走 HttpClientPort
// （适配器侧自带公网边界与代理处理），用户输入只进查询参数，URL 主机全部为常量。
// 失败语义：单渠道失败返回 "Error: ..." 文本而非抛错——模型可换渠道继续，
// 不会中断整个回合（与 Python 原型一致，也与研究场景的降级预期一致）。
// ============================================================

import {
  CoreErrorType,
  createCoreError,
  RESEARCH_TOOL_SCHEMAS,
  ResearchToolOutputSchema,
  makeResearchToolContract,
  type HttpClientResponse,
  type ResearchToolOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";

const RESEARCH_USER_AGENT = "ZCode-Research/0.1 (+https://zcode.ai; coding-agent-cli)";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 512_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

interface ResearchChannelContext {
  httpClientPort: NonNullable<ToolExecutionContext["httpClientPort"]>;
  abortSignal: AbortSignal;
  toolName: string;
  toolCallId: string;
}

const TEXT_DECODER = new TextDecoder("utf8");

async function fetchText(
  http: ResearchChannelContext,
  url: string,
): Promise<string> {
  const response = await request(http, url);
  return TEXT_DECODER.decode(response.body);
}

async function fetchJson(http: ResearchChannelContext, url: string): Promise<unknown> {
  const text = await fetchText(http, url);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`invalid JSON response from ${new URL(url).host}`);
  }
}

async function request(
  http: ResearchChannelContext,
  url: string,
): Promise<HttpClientResponse> {
  const response = await http.httpClientPort.request(
    {
      url,
      method: "GET",
      headers: { "User-Agent": RESEARCH_USER_AGENT, Accept: "*/*" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      redirect: "follow",
    },
    { signal: http.abortSignal },
  );
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  }
  return response;
}

function clampLimit(limit: unknown): number {
  const value = typeof limit === "number" ? Math.floor(limit) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(value, MAX_LIMIT));
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_HTML_ENTITIES[entity] ?? match;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

// ---- per-channel formatters (ports of research_tools.py) ----

function formatContext7Search(payload: unknown): string {
  const results = asArray(asRecord(payload).results);
  if (results.length === 0) {
    return "No matching libraries found. Try a different library name.";
  }
  const lines = results.map((item) => {
    const record = asRecord(item);
    return `- ${asString(record.title) || "?"} (id: ${asString(record.id) || "?"})\n  ${asString(record.description).trim()}`;
  });
  lines.push("", "Use GetLibraryDocs with a library id above to read its documentation.");
  return lines.join("\n");
}

function formatStackOverflow(payload: unknown): string {
  const items = asArray(asRecord(payload).items);
  if (items.length === 0) {
    return "No matching questions found.";
  }
  return items
    .map((item) => {
      const record = asRecord(item);
      const tags = asArray(record.tags)
        .map((tag) => asString(tag))
        .filter(Boolean)
        .join(", ");
      const answered = record.is_answered === true ? "answered" : "unanswered";
      return `- [${asNumber(record.score)} pts, ${answered}] ${decodeHtmlEntities(asString(record.title) || "?")}\n  ${asString(record.link)}\n  tags: ${tags}`;
    })
    .join("\n");
}

function formatGitHub(payload: unknown): string {
  const items = asArray(asRecord(payload).items);
  if (items.length === 0) {
    return "No matching repositories found.";
  }
  return items
    .map((item) => {
      const record = asRecord(item);
      return `- ${asString(record.full_name) || "?"} (★${asNumber(record.stargazers_count)}, ${asString(record.language) || "n/a"})\n  ${asString(record.html_url)}\n  ${asString(record.description).trim()}`;
    })
    .join("\n");
}

function formatHackerNews(payload: unknown): string {
  const hits = asArray(asRecord(payload).hits);
  if (hits.length === 0) {
    return "No matching stories found.";
  }
  return hits
    .map((hit) => {
      const record = asRecord(hit);
      const url =
        asString(record.url) ||
        `https://news.ycombinator.com/item?id=${asString(record.objectID)}`;
      return `- [${asNumber(record.points)} pts, ${asNumber(record.num_comments)} comments] ${asString(record.title) || "?"}\n  ${url}\n  by ${asString(record.author) || "?"}`;
    })
    .join("\n");
}

interface ArxivEntry {
  title: string;
  summary: string;
  link: string;
  published: string;
  authors: string[];
}

function parseArxivFeed(xmlText: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  const pick = (block: string, tag: string): string => {
    const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return match ? decodeHtmlEntities(match[1]!.trim()) : "";
  };
  for (const match of xmlText.matchAll(entryPattern)) {
    const block = match[1]!;
    const pdfLink = block.match(/<link[^>]*type="application\/pdf"[^>]*href="([^"]+)"/);
    const idMatch = block.match(/<id>([\s\S]*?)<\/id>/);
    entries.push({
      title: pick(block, "title"),
      summary: pick(block, "summary"),
      link: pdfLink?.[1] ?? idMatch?.[1]?.trim() ?? "",
      published: pick(block, "published").slice(0, 10),
      authors: [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((author) =>
        decodeHtmlEntities(author[1]!.trim()),
      ),
    });
  }
  return entries;
}

function formatArxiv(xmlText: string): string {
  const entries = parseArxivFeed(xmlText);
  if (entries.length === 0) {
    return "No matching papers found.";
  }
  return entries
    .map(
      (entry) =>
        `- ${entry.title || "?"} (${entry.published})\n  ${entry.link}\n  authors: ${entry.authors.filter(Boolean).join(", ")}\n  ${entry.summary.slice(0, 300)}`,
    )
    .join("\n");
}

function formatNpm(payload: unknown): string {
  const objects = asArray(asRecord(payload).objects);
  if (objects.length === 0) {
    return "No matching packages found.";
  }
  return objects
    .map((item) => {
      const record = asRecord(item);
      const pkg = asRecord(record.package);
      const downloads = asRecord(record.downloads).monthly;
      const parts: string[] = [];
      if (typeof downloads === "number") {
        parts.push(`${downloads.toLocaleString("en-US")} downloads/mo`);
      }
      if (typeof record.dependents === "number") {
        parts.push(`${record.dependents.toLocaleString("en-US")} dependents`);
      }
      parts.push(`v${asString(pkg.version) || "?"}`);
      const links = asRecord(pkg.links);
      return `- ${asString(pkg.name) || "?"} (${parts.join(", ")})\n  ${asString(links.npm)}\n  ${asString(pkg.description)}`;
    })
    .join("\n");
}

function formatPyPI(payload: unknown, name: string): string {
  const info = asRecord(asRecord(payload).info);
  if (Object.keys(info).length === 0) {
    return `Package '${name}' not found on PyPI.`;
  }
  const lines = [
    `- ${asString(info.name) || name} (latest: ${asString(info.version) || "?"}${info.requires_python ? `, requires Python ${asString(info.requires_python)}` : ""})`,
  ];
  const projectUrl = asString(info.project_url) || asString(info.home_page);
  if (projectUrl) {
    lines.push(`  ${projectUrl}`);
  }
  if (asString(info.summary)) {
    lines.push(`  ${asString(info.summary)}`);
  }
  return lines.join("\n");
}

function formatMdn(payload: unknown): string {
  const documents = asArray(asRecord(payload).documents);
  if (documents.length === 0) {
    return "No matching MDN pages found.";
  }
  return documents
    .map((doc) => {
      const record = asRecord(doc);
      return `- ${asString(record.title) || "?"}\n  https://developer.mozilla.org${asString(record.mdn_url)}\n  ${asString(record.summary)}`;
    })
    .join("\n");
}

function formatPapers(payload: unknown): string {
  const results = asArray(asRecord(payload).results);
  if (results.length === 0) {
    return "No matching works found.";
  }
  return results
    .map((work) => {
      const record = asRecord(work);
      const venue = asRecord(asRecord(record.primary_location).source);
      const authors = asArray(record.authorships)
        .slice(0, 4)
        .map((authorship) => asString(asRecord(asRecord(authorship).author).display_name))
        .filter(Boolean)
        .join(", ");
      return `- ${asString(record.display_name) || "?"} (${asString(record.publication_year) || "?"}, ${asNumber(record.cited_by_count)} citations${venue.display_name ? `, ${asString(venue.display_name)}` : ""})\n  ${asString(record.doi)}\n  authors: ${authors}`;
    })
    .join("\n");
}

function formatPubmed(search: unknown, summary: unknown): string {
  const ids = asArray(asRecord(asRecord(search).esearchresult).idlist);
  if (ids.length === 0) {
    return "No matching articles found.";
  }
  const results = asRecord(asRecord(summary).result);
  const lines: string[] = [];
  for (const pmid of ids) {
    const item = asRecord(results[asString(pmid)]);
    if (Object.keys(item).length === 0) continue;
    const authors = asArray(item.authors)
      .slice(0, 4)
      .map((author) => asString(asRecord(author).name))
      .filter(Boolean)
      .join(", ");
    lines.push(
      `- ${asString(item.title).replace(/\.$/, "")}\n  https://pubmed.ncbi.nlm.nih.gov/${asString(pmid)}/\n  ${asString(item.source)} ${asString(item.pubdate)}${authors ? `; authors: ${authors}` : ""}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "No matching articles found.";
}

// ---- per-channel execute functions ----

type ResearchChannelExecute = (
  input: Record<string, unknown>,
  http: ResearchChannelContext,
) => Promise<string>;

async function executeSearchDocs(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    query: asString(input.query),
    limit: String(clampLimit(input.limit)),
  });
  return formatContext7Search(await fetchJson(http, `https://context7.com/api/v1/search?${params}`));
}

async function executeGetLibraryDocs(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  let libraryId = asString(input.libraryId).trim();
  if (!libraryId.startsWith("/")) {
    libraryId = `/${libraryId}`;
  }
  const tokens =
    typeof input.tokens === "number" ? Math.max(500, Math.min(Math.floor(input.tokens), 20000)) : 4000;
  const params = new URLSearchParams({ tokens: String(tokens) });
  const topic = asString(input.topic).trim();
  if (topic) {
    params.set("topic", topic);
  }
  const text = await fetchText(http, `https://context7.com${libraryId}/llms.txt?${params}`);
  return text.trim() || "No documentation content returned.";
}

async function executeSearchStackOverflow(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    order: "desc",
    sort: "relevance",
    q: asString(input.query),
    site: asString(input.site).trim() || "stackoverflow",
    pagesize: String(clampLimit(input.limit)),
  });
  return formatStackOverflow(
    await fetchJson(http, `https://api.stackexchange.com/2.3/search/advanced?${params}`),
  );
}

async function executeSearchGitHub(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    q: asString(input.query),
    per_page: String(clampLimit(input.limit)),
  });
  try {
    return formatGitHub(await fetchJson(http, `https://api.github.com/search/repositories?${params}`));
  } catch (error) {
    if (error instanceof Error && error.message.includes("HTTP 403")) {
      return "Error: GitHub API rate limit reached (unauthenticated requests are capped). Wait a minute or use web search instead.";
    }
    throw error;
  }
}

async function executeSearchHackerNews(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    query: asString(input.query),
    hitsPerPage: String(clampLimit(input.limit)),
  });
  return formatHackerNews(await fetchJson(http, `https://hn.algolia.com/api/v1/search?${params}`));
}

async function executeSearchArxiv(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    search_query: `all:${asString(input.query)}`,
    max_results: String(clampLimit(input.limit)),
    sortBy: "relevance",
  });
  return formatArxiv(await fetchText(http, `https://export.arxiv.org/api/query?${params}`));
}

async function executeSearchNpm(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    text: asString(input.query),
    size: String(clampLimit(input.limit)),
  });
  return formatNpm(await fetchJson(http, `https://registry.npmjs.org/-/v1/search?${params}`));
}

async function executeSearchPyPI(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const name = asString(input.name).trim();
  let payload: unknown;
  try {
    payload = await fetchJson(http, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("HTTP 404")) {
      return `Package '${name}' not found on PyPI.`;
    }
    throw error;
  }
  return formatPyPI(payload, name);
}

async function executeSearchMdn(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    q: asString(input.query),
    size: String(clampLimit(input.limit)),
  });
  return formatMdn(await fetchJson(http, `https://developer.mozilla.org/api/v1/search?${params}`));
}

async function executeSearchPapers(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const params = new URLSearchParams({
    search: asString(input.query),
    per_page: String(clampLimit(input.limit)),
  });
  return formatPapers(await fetchJson(http, `https://api.openalex.org/works?${params}`));
}

async function executeSearchPubmed(
  input: Record<string, unknown>,
  http: ResearchChannelContext,
): Promise<string> {
  const count = clampLimit(input.limit);
  const searchParams = new URLSearchParams({
    db: "pubmed",
    term: asString(input.query),
    retmode: "json",
    retmax: String(count),
  });
  const search = await fetchJson(
    http,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams}`,
  );
  const ids = asArray(asRecord(asRecord(search).esearchresult).idlist).map((id) => asString(id));
  if (ids.length === 0) {
    return "No matching articles found.";
  }
  const summaryParams = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
  });
  const summary = await fetchJson(
    http,
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${summaryParams}`,
  );
  return formatPubmed(search, summary);
}

interface ResearchChannelSpec {
  name: string;
  capability: string;
  description: string;
  execute: ResearchChannelExecute;
}

const RESEARCH_CHANNELS: ResearchChannelSpec[] = [
  {
    name: "SearchDocs",
    capability: "Search Context7 for libraries, frameworks, and their official documentation ids",
    description: [
      "Search for libraries, frameworks, and their official documentation.",
      "",
      "Use FIRST for questions about how to use a library, framework, API, or tool (e.g. React, FastAPI, PostgreSQL). Returns matching libraries with their Context7 ids; follow up with GetLibraryDocs to read the documentation.",
    ].join("\n"),
    execute: executeSearchDocs,
  },
  {
    name: "GetLibraryDocs",
    capability: "Read documentation excerpts for a library found via SearchDocs",
    description:
      "Read documentation excerpts for a library found via SearchDocs. Pass an optional topic to focus the excerpt.",
    execute: executeGetLibraryDocs,
  },
  {
    name: "SearchStackOverflow",
    capability: "Search Stack Overflow / Stack Exchange for programming questions",
    description: [
      "Search Stack Overflow (or any Stack Exchange site) for questions and answers.",
      "",
      "Best for concrete coding problems, error messages, and how-to questions. Pass another `site` to search the wider network: superuser, serverfault, math, stats, ai, softwareengineering, and every other Stack Exchange site.",
    ].join("\n"),
    execute: executeSearchStackOverflow,
  },
  {
    name: "SearchGitHub",
    capability: "Search GitHub for repositories and projects",
    description:
      "Search GitHub for repositories, projects, and source code hosts. Best for finding implementations, tools, and comparing project popularity.",
    execute: executeSearchGitHub,
  },
  {
    name: "SearchHackerNews",
    capability: "Search Hacker News for tech community discussions",
    description:
      "Search Hacker News for tech community discussions and industry takes. Best for opinions, product launches, release reactions, and \"what does the community think about X\".",
    execute: executeSearchHackerNews,
  },
  {
    name: "SearchArxiv",
    capability: "Search arXiv for academic papers and preprints",
    description:
      "Search arXiv for academic papers and research preprints. Best for algorithms, models, and scientific/technical background.",
    execute: executeSearchArxiv,
  },
  {
    name: "SearchNpm",
    capability: "Search the npm registry for JavaScript/TypeScript packages",
    description:
      "Search npm for JavaScript/TypeScript packages. Results show monthly downloads, dependents, and the current version for popularity signals.",
    execute: executeSearchNpm,
  },
  {
    name: "SearchPyPI",
    capability: "Look up a Python package on PyPI by exact name",
    description:
      "Look up a Python package on PyPI by exact name. Returns the latest version, supported Python versions, project link, and summary. Use SearchGitHub or web search for fuzzy discovery; this tool confirms details once you know the package name.",
    execute: executeSearchPyPI,
  },
  {
    name: "SearchMdn",
    capability: "Search MDN Web Docs for Web platform APIs and standards",
    description:
      "Search MDN Web Docs for Web platform APIs and standards. Best for JavaScript/HTML/CSS/DOM/Web API references — authoritative, browser-vendor-maintained documentation.",
    execute: executeSearchMdn,
  },
  {
    name: "SearchPapers",
    capability: "Search academic works across all disciplines (OpenAlex)",
    description:
      "Search academic works across all disciplines (OpenAlex index). Covers journal articles, conference papers, and preprints in every field — not just computer science. Results show venue, year, and citation counts. For CS preprints specifically, SearchArxiv is faster.",
    execute: executeSearchPapers,
  },
  {
    name: "SearchPubmed",
    capability: "Search PubMed for biomedical and life-science literature",
    description:
      "Search PubMed for biomedical and life-science literature. Best for medicine, biology, pharmacology, and clinical questions.",
    execute: executeSearchPubmed,
  },
];

function resolveResearchContext(context: ToolExecutionContext, toolName: string): ResearchChannelContext {
  if (!context.httpClientPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `HttpClientPort is not configured for ${toolName}`,
      {
        context: { toolCallId: context.toolCallId, toolName },
        recoverable: false,
      },
    );
  }
  return {
    httpClientPort: context.httpClientPort,
    abortSignal: context.abortSignal,
    toolName,
    toolCallId: context.toolCallId,
  };
}

function formatResearchModelContent(output: unknown): string {
  const parsed = ResearchToolOutputSchema.safeParse(output);
  return parsed.success ? parsed.data.result : JSON.stringify(output);
}

function makeResearchToolEntry(spec: ResearchChannelSpec): ToolEntry {
  const schemaSet = RESEARCH_TOOL_SCHEMAS[spec.name]!;
  const handler: ToolHandler = async (input, context) => {
    const parsed = schemaSet.inputSchema.parse(input) as Record<string, unknown>;
    const http = resolveResearchContext(context, spec.name);
    let result: string;
    try {
      result = await spec.execute(parsed, http);
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        throw error;
      }
      result = `Error: ${spec.name} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { result } satisfies ResearchToolOutput;
  };

  return {
    ...makeResearchToolContract({ name: spec.name, capability: spec.capability }),
    metadata: {
      name: spec.name,
      description: spec.description,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      timeoutMs: 30_000,
      maxOutputBytes: 80_000,
      sideEffectScope: "network",
      riskLevel: "low",
      needsApproval: false,
    },
    handler: handler as ToolHandler,
    formatModelContent: formatResearchModelContent,
    runtimeInputSchema: schemaSet.inputSchema,
    runtimeOutputSchema: schemaSet.outputSchema,
  };
}

/** research 模式检索渠道工具；注册进 builtInTools 后对所有会话可见（只读，无副作用）。 */
export const researchToolEntries: ToolEntry[] = RESEARCH_CHANNELS.map(makeResearchToolEntry);
