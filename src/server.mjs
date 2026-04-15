#!/usr/bin/env node
/**
 * Windsurf Fast Context MCP Server (Node.js)
 *
 * AI-driven semantic code search via reverse-engineered Windsurf protocol.
 *
 * Configuration (environment variables):
 *   WINDSURF_API_KEY     — Windsurf API key (auto-discovered from local install if not set)
 *   FC_MAX_TURNS         — Search rounds per query (default: 3)
 *   FC_MAX_COMMANDS      — Max parallel commands per round (default: 8)
 *   FC_TIMEOUT_MS        — Connect-Timeout-Ms for streaming requests (default: 30000)
 *
 * Start:
 *   node src/server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchWithContent } from "./core.mjs";

/**
 * Parse an integer env var with optional clamping.
 * @param {string} name
 * @param {number} defaultValue
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
function readIntEnv(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = typeof opts.min === "number" ? opts.min : null;
  const max = typeof opts.max === "number" ? opts.max : null;
  let value = parsed;
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

// Read config from environment
const MAX_TURNS = readIntEnv("FC_MAX_TURNS", 3, { min: 1, max: 5 });
const MAX_COMMANDS = readIntEnv("FC_MAX_COMMANDS", 8, { min: 1, max: 20 });
const TIMEOUT_MS = readIntEnv("FC_TIMEOUT_MS", 30000, { min: 1000, max: 300000 });

const server = new McpServer({
  name: "windsurf-fast-context",
  version: "1.2.0",
  instructions:
    "Windsurf Fast Context — AI-driven semantic code search. " +
    "Returns file paths with line ranges and grep keywords.\n" +
    "Tunable parameters:\n" +
    "- tree_depth (1-6, default 3): How much directory structure the remote AI sees. " +
    "REDUCE if you get payload/size errors. INCREASE for small projects where deeper structure helps.\n" +
    "- max_turns (1-5, default 3): How many search rounds. " +
    "INCREASE if results are incomplete. Use 1 for quick lookups.\n" +
    "- max_results (1-30, default 10): Maximum number of files to return.\n" +
    "- exclude_paths (string array, default []): Directory/file patterns to exclude from tree. " +
    "Use for large repos to reduce payload size (e.g. ['node_modules', 'dist', '.git']).\n" +
    "The response includes [config] and [diagnostic] lines — read them to decide if you should retry with different parameters.",
});

// ─── Tool: codebase_search ─────────────────────────────

server.tool(
  "codebase_search",
  "Find snippets of code from the codebase most relevant to the search query. " +
  "This performs best when the search query is more precise and relating to the function or purpose of code. " +
  "Results will be poor if asking a very broad question, such as asking about the general 'framework' or 'implementation' " +
  "of a large component or system. Will only show the full code contents of the top items, and they may also be truncated. " +
  "For other items it will only show the docstring and signature. " +
  "Use view_code_item with the same path and node name to view the full code contents for any item. " +
  "Note that if you try to search over more than 500 files, the quality of the search results will be substantially worse. " +
  "Try to only search over a large number of files if it is really necessary.",
  {
    query: z.string().describe(
      'Natural language search query (e.g. "where is auth handled", "database connection pool")'
    ),
    project_path: z
      .string()
      .default("")
      .describe("Absolute path to project root. Empty = current working directory."),
    tree_depth: z
      .number()
      .int()
      .min(1)
      .max(6)
      .default(3)
      .describe(
        "Directory tree depth for the initial repo map sent to the remote AI. " +
        "Default 3. Use 1-2 for huge monorepos (>5000 files) or if you get payload size errors. " +
        "Use 4-6 for small projects (<200 files) where you want the AI to see deeper structure. " +
        "Auto falls back to a lower depth if tree output exceeds 250KB."
      ),
    max_turns: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(MAX_TURNS)
      .describe(
        "Number of search rounds. Each round: remote AI generates search commands → local execution → results sent back. " +
        "Default 3. Use 1 for quick simple lookups. Use 4-5 for complex queries requiring deep tracing across many files. " +
        "More rounds = better results but slower and uses more API quota."
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe(
        "Maximum number of files to return. Default 10. " +
        "Use a smaller value (3-5) for focused queries. " +
        "Use a larger value (15-30) for broad exploration queries."
      ),
    exclude_paths: z
      .array(z.string())
      .default([])
      .describe(
        "Directory/file patterns to exclude from tree and search context. " +
        "Useful for reducing payload size on large repos. " +
        "Examples: ['node_modules', 'dist', '.git', 'build', 'coverage', '*.min.*']"
      ),
  },
  async ({ query, project_path, tree_depth, max_turns, max_results, exclude_paths }) => {
    let projectPath = project_path || process.cwd();

    try {
      const { statSync } = await import("node:fs");
      if (!statSync(projectPath).isDirectory()) {
        return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
      }
    } catch {
      return { content: [{ type: "text", text: `Error: project path does not exist: ${projectPath}` }] };
    }

    try {
      const result = await searchWithContent({
        query,
        projectRoot: projectPath,
        maxTurns: max_turns,
        maxCommands: MAX_COMMANDS,
        maxResults: max_results,
        treeDepth: tree_depth,
        timeoutMs: TIMEOUT_MS,
        excludePaths: exclude_paths,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      const code = e.code || "UNKNOWN";
      return {
        content: [{
          type: "text", text:
            `Error [${code}]: ${e.message}\n\n` +
            `[hint] Suggestions based on error type:\n` +
            `  - Reduce tree_depth (current: ${tree_depth})\n` +
            `  - Add exclude_paths to filter large directories (e.g. ['node_modules', 'dist'])\n` +
            `  - Narrow project_path to a subdirectory\n` +
            `  - Reduce max_turns (current: ${max_turns})`
        }]
      };
    }
  }
);

// ─── Start ─────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
