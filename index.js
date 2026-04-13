import { tool } from "@opencode-ai/plugin";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const DEFAULT_OPTIONS = Object.freeze({
  memoryRoot: join(homedir(), ".claude", "projects"),
  injectMode: "once",
  initialLoadMode: "full",
  compactionMode: "index",
  autoReview: false,
  minMessagesForExtraction: 4,
  minNewMessagesForReview: 4,
  maxIndexLines: 200,
  maxIndexBytes: 25 * 1024,
  showLoadToast: true,
  showReviewToast: true,
  showUpdateToast: true,
  memoryUpdateToastDebounceMs: 1500,
  debug: false,
});

const VALID_INJECT_MODES = new Set(["once", "always"]);
const VALID_LOAD_MODES = new Set(["full", "index"]);
const VALID_COMPACTION_MODES = new Set(["none", "index", "full"]);

function encodeProjectPath(dir) {
  return ("-" + dir.replace(/\//g, "-")).replace(/^-+/, "-");
}

function resolveBooleanOption(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function resolveNumberOption(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveEnumOption(value, fallback, validValues) {
  return typeof value === "string" && validValues.has(value) ? value : fallback;
}

function resolveStringOption(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveOptions(rawOptions = {}) {
  return {
    memoryRoot: resolveStringOption(rawOptions.memoryRoot, DEFAULT_OPTIONS.memoryRoot),
    injectMode: resolveEnumOption(rawOptions.injectMode, DEFAULT_OPTIONS.injectMode, VALID_INJECT_MODES),
    initialLoadMode: resolveEnumOption(
      rawOptions.initialLoadMode,
      DEFAULT_OPTIONS.initialLoadMode,
      VALID_LOAD_MODES,
    ),
    compactionMode: resolveEnumOption(
      rawOptions.compactionMode,
      DEFAULT_OPTIONS.compactionMode,
      VALID_COMPACTION_MODES,
    ),
    autoReview: resolveBooleanOption(rawOptions.autoReview, DEFAULT_OPTIONS.autoReview),
    minMessagesForExtraction: Math.max(
      1,
      resolveNumberOption(rawOptions.minMessagesForExtraction, DEFAULT_OPTIONS.minMessagesForExtraction),
    ),
    minNewMessagesForReview: Math.max(
      1,
      resolveNumberOption(rawOptions.minNewMessagesForReview, DEFAULT_OPTIONS.minNewMessagesForReview),
    ),
    maxIndexLines: Math.max(1, resolveNumberOption(rawOptions.maxIndexLines, DEFAULT_OPTIONS.maxIndexLines)),
    maxIndexBytes: Math.max(1024, resolveNumberOption(rawOptions.maxIndexBytes, DEFAULT_OPTIONS.maxIndexBytes)),
    showLoadToast: resolveBooleanOption(rawOptions.showLoadToast, DEFAULT_OPTIONS.showLoadToast),
    showReviewToast: resolveBooleanOption(rawOptions.showReviewToast, DEFAULT_OPTIONS.showReviewToast),
    showUpdateToast: resolveBooleanOption(rawOptions.showUpdateToast, DEFAULT_OPTIONS.showUpdateToast),
    memoryUpdateToastDebounceMs: Math.max(
      0,
      resolveNumberOption(
        rawOptions.memoryUpdateToastDebounceMs,
        DEFAULT_OPTIONS.memoryUpdateToastDebounceMs,
      ),
    ),
    debug: resolveBooleanOption(rawOptions.debug, DEFAULT_OPTIONS.debug),
  };
}

function defaultGitRootResolver(projectDir) {
  return execSync("git rev-parse --show-toplevel", {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function findClaudeMemoryDir(
  projectDir,
  memoryRoot,
  { exists = existsSync, resolveGitRoot = defaultGitRootResolver } = {},
) {
  const encoded = encodeProjectPath(projectDir);
  const exactPath = join(memoryRoot, encoded, "memory");
  if (exists(exactPath)) return exactPath;

  try {
    const gitRoot = resolveGitRoot(projectDir);
    if (!gitRoot) return null;
    const gitEncoded = encodeProjectPath(gitRoot);
    const gitPath = join(memoryRoot, gitEncoded, "memory");
    if (exists(gitPath)) return gitPath;
  } catch {}

  return null;
}

function readAllMemoryFiles(memoryDir) {
  if (!memoryDir || !existsSync(memoryDir)) return { index: null, topics: {} };

  const indexPath = join(memoryDir, "MEMORY.md");
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

  const topics = {};
  try {
    for (const entry of readdirSync(memoryDir).sort()) {
      if (entry === "MEMORY.md" || !entry.endsWith(".md")) continue;
      const fullPath = join(memoryDir, entry);
      if (statSync(fullPath).isFile()) {
        topics[entry] = readFileSync(fullPath, "utf8");
      }
    }
  } catch {}

  return { index, topics };
}

function trimIndex(index, config) {
  let output = index;
  const lines = output.split("\n");
  if (lines.length > config.maxIndexLines) {
    output = lines.slice(0, config.maxIndexLines).join("\n");
  }
  if (output.length > config.maxIndexBytes) {
    output = output.slice(0, config.maxIndexBytes);
  }
  return output;
}

function buildInitialMemoryContext(memoryDir, config) {
  const { index, topics } = readAllMemoryFiles(memoryDir);
  if (!index) return null;

  let memoryContext = "## Claude Code Memory (from previous sessions)\n\n";
  memoryContext +=
    "This memory was loaded at the start of the session. Use the `claude_memory` tool to search, read, or update it later.\n\n";
  memoryContext += `### MEMORY.md\n\n${index}`;

  if (config.initialLoadMode === "full") {
    for (const key of Object.keys(topics).sort()) {
      memoryContext += `\n\n### ${key}\n\n${topics[key]}`;
    }
  } else {
    const topicKeys = Object.keys(topics).sort();
    if (topicKeys.length > 0) {
      memoryContext += "\n\n### Topic Files\n\n";
      for (const key of topicKeys) {
        memoryContext += `- ${key}\n`;
      }
    }
  }

  return memoryContext;
}

function buildCompactionMemoryContext(memoryDir, config) {
  if (config.compactionMode === "none") return null;

  const { index, topics } = readAllMemoryFiles(memoryDir);
  if (!index) return null;

  if (config.compactionMode === "full") {
    return buildInitialMemoryContext(memoryDir, { ...config, initialLoadMode: "full" });
  }

  let memoryContext = "## Claude Code Memory Reference\n\n";
  memoryContext +=
    "This session started with Claude Code memory loaded from disk. Preserve relevant facts in the compacted continuation.\n\n";
  memoryContext += `### MEMORY.md (trimmed)\n\n${trimIndex(index, config)}`;

  const topicKeys = Object.keys(topics).sort();
  if (topicKeys.length > 0) {
    memoryContext += "\n\n### Topic Files\n\n";
    for (const key of topicKeys) {
      memoryContext += `- ${key}\n`;
    }
  }

  memoryContext += "\nUse the `claude_memory` tool if the continuation needs a full memory file.\n";
  return memoryContext;
}

function resolveMemoryFilePath(memoryDir, filePath) {
  if (typeof filePath !== "string") return null;
  const trimmedPath = filePath.trim();
  if (!trimmedPath || trimmedPath.includes("\0")) return null;

  const root = resolve(memoryDir);
  const target = resolve(memoryDir, trimmedPath);
  const relativePath = relative(root, target);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return target;
  }

  return null;
}

function isPathInsideDirectory(baseDirectory, targetDirectory, filePath) {
  if (!filePath) return false;
  const resolvedPath = resolve(baseDirectory, filePath);
  const relativePath = relative(resolve(targetDirectory), resolvedPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function getToolFilePath(args) {
  if (!args || typeof args !== "object") return null;

  for (const key of ["filePath", "path", "file", "targetPath"]) {
    if (typeof args[key] === "string") return args[key];
  }

  return null;
}

function getSessionState(stateMap, sessionID) {
  let state = stateMap.get(sessionID);
  if (state) return state;

  state = {
    loaded: false,
    reviewing: false,
    lastReviewedMessageCount: 0,
    lastMemoryUpdateToastAt: 0,
  };
  stateMap.set(sessionID, state);
  return state;
}

export const ClaudeMemoryPlugin = async (ctx, rawOptions = {}) => {
  const { directory, client } = ctx;
  const config = resolveOptions(rawOptions);
  const sessionState = new Map();

  let memoryDirCache;
  function getMemoryDir() {
    if (memoryDirCache !== undefined) return memoryDirCache;
    memoryDirCache = findClaudeMemoryDir(directory, config.memoryRoot);
    return memoryDirCache;
  }

  function logError(scope, error) {
    if (!config.debug) return;
    console.error(`[opencode-claude-memory] ${scope}`, error);
  }

  async function showToast(title, message, variant = "info", duration = 2500) {
    try {
      await client.tui.showToast({
        body: { title, message, variant, duration },
      });
    } catch (error) {
      logError("showToast", error);
    }
  }

  return {
    "chat.message": async (input, output) => {
      const state = getSessionState(sessionState, input.sessionID);
      if (config.injectMode === "once" && state.loaded) return;

      const memoryDir = getMemoryDir();
      if (!memoryDir) return;

      try {
        const memoryContext = buildInitialMemoryContext(memoryDir, config);
        if (!memoryContext) return;

        output.parts.unshift({
          id: `prt-claude-memory-${Date.now()}`,
          sessionID: input.sessionID,
          messageID: output.message.id,
          type: "text",
          text: memoryContext,
          synthetic: true,
        });

        state.loaded = true;
        if (config.showLoadToast) {
          await showToast("Memory", "Claude memory loaded for this session", "info", 2000);
        }
      } catch (error) {
        logError("chat.message", error);
      }
    },

    event: async ({ event }) => {
      if (!config.autoReview || !event || event.type !== "session.idle") return;

      const sessionID = event.properties?.sessionID;
      if (!sessionID) return;

      const state = getSessionState(sessionState, sessionID);
      if (state.reviewing) {
        state.reviewing = false;
        return;
      }

      const memoryDir = getMemoryDir();
      if (!memoryDir) return;

      try {
        const messagesResponse = await client.session.messages({ path: { id: sessionID } });
        const messages = messagesResponse?.data || [];
        if (messages.length < config.minMessagesForExtraction) return;

        const newMessages = messages.length - state.lastReviewedMessageCount;
        if (state.lastReviewedMessageCount > 0 && newMessages < config.minNewMessagesForReview) return;

        state.reviewing = true;
        state.lastReviewedMessageCount = messages.length;

        if (config.showReviewToast) {
          await showToast("Memory", "Reviewing session for Claude memory", "info", 2000);
        }

        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: `Review this conversation and extract any learnings, preferences, or patterns worth remembering for future sessions. Write them to the Claude Code memory files at:

Memory directory: ${memoryDir}
Index file: ${join(memoryDir, "MEMORY.md")}

Rules:
- Keep MEMORY.md under 200 lines — it's an index that links to topic files
- Create or update topic files (for example: project_architecture.md, debugging_patterns.md) for detailed notes
- Use markdown format
- Focus on build commands, debugging insights, architecture decisions, code style preferences, and workflow habits
- Only write something if it would genuinely be useful in a future session
- Do NOT write anything that is already in CLAUDE.md or AGENTS.md

Use the write and edit tools to create or update these files. If there is nothing worth remembering, reply with a single line and do not write any files.`,
                synthetic: true,
              },
            ],
          },
        });
      } catch (error) {
        state.reviewing = false;
        logError("event.session.idle", error);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!config.showUpdateToast) return;

      const memoryDir = getMemoryDir();
      if (!memoryDir) return;

      const state = getSessionState(sessionState, input.sessionID);
      let updatedPath = null;

      if (input.tool === "write" || input.tool === "edit") {
        const candidatePath = getToolFilePath(input.args);
        if (candidatePath && isPathInsideDirectory(directory, memoryDir, candidatePath)) {
          updatedPath = resolve(directory, candidatePath);
        }
      }

      if (input.tool === "claude_memory") {
        try {
          const result = JSON.parse(output.output);
          if (result?.success && result?.path) {
            const safePath = resolveMemoryFilePath(memoryDir, relative(memoryDir, result.path));
            if (safePath) updatedPath = safePath;
          }
        } catch (error) {
          logError("tool.execute.after.parse", error);
        }
      }

      if (!updatedPath) return;

      const now = Date.now();
      if (now - state.lastMemoryUpdateToastAt < config.memoryUpdateToastDebounceMs) return;
      state.lastMemoryUpdateToastAt = now;

      const message = state.reviewing
        ? "Claude memory updated from this session"
        : `Claude memory updated: ${basename(updatedPath)}`;
      await showToast("Memory", message, "success", 2500);
    },

    "experimental.session.compacting": async (_input, output) => {
      const memoryDir = getMemoryDir();
      if (!memoryDir) return;

      try {
        const memoryContext = buildCompactionMemoryContext(memoryDir, config);
        if (memoryContext) {
          output.context.push(memoryContext);
        }
      } catch (error) {
        logError("experimental.session.compacting", error);
      }
    },

    tool: {
      claude_memory: tool({
        description:
          "Read and update Claude Code auto-memory files. Use 'read' to view memory index or topic files, 'search' to find memories by keyword, 'add' to append a note to the memory index, 'update' to replace a topic file, and 'list' to see available topic files.",
        args: {
          mode: tool.schema.enum(["read", "search", "add", "update", "list"]).optional(),
          file: tool.schema.string().optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
        },
        async execute(args) {
          const memoryDir = getMemoryDir();
          if (!memoryDir) {
            return JSON.stringify({
              success: false,
              error: "No Claude Code memory directory found for this project.",
            });
          }

          const mode = args.mode || "list";

          try {
            switch (mode) {
              case "list": {
                const { index, topics } = readAllMemoryFiles(memoryDir);
                if (!index && Object.keys(topics).length === 0) {
                  return JSON.stringify({
                    success: true,
                    message: "No memories yet. Use mode 'add' to save a note.",
                    directory: memoryDir,
                  });
                }

                return JSON.stringify({
                  success: true,
                  directory: memoryDir,
                  index: index ? `${index.split("\n").length} lines` : "empty",
                  topics: Object.keys(topics)
                    .sort()
                    .map((file) => ({
                      file,
                      lines: topics[file].split("\n").length,
                      size: `${(topics[file].length / 1024).toFixed(1)}KB`,
                    })),
                });
              }

              case "read": {
                if (!args.file) {
                  const { index, topics } = readAllMemoryFiles(memoryDir);
                  let combined = "";
                  if (index) combined += `# MEMORY.md\n\n${index}\n`;
                  for (const file of Object.keys(topics).sort()) {
                    combined += `\n# ${file}\n\n${topics[file]}\n`;
                  }
                  return JSON.stringify({ success: true, content: combined || "No memories found" });
                }

                const filePath = resolveMemoryFilePath(memoryDir, args.file);
                if (!filePath || !existsSync(filePath)) {
                  return JSON.stringify({
                    success: false,
                    error: `File not found: ${args.file}`,
                    available: Object.keys(readAllMemoryFiles(memoryDir).topics).sort(),
                  });
                }

                return JSON.stringify({
                  success: true,
                  file: relative(memoryDir, filePath),
                  content: readFileSync(filePath, "utf8"),
                });
              }

              case "search": {
                if (!args.query) {
                  return JSON.stringify({ success: false, error: "query is required for search" });
                }

                const queryLower = args.query.toLowerCase();
                const { index, topics } = readAllMemoryFiles(memoryDir);
                const results = [];

                if (index && index.toLowerCase().includes(queryLower)) {
                  results.push({ file: "MEMORY.md", match: "index" });
                }

                for (const file of Object.keys(topics).sort()) {
                  const content = topics[file];
                  if (!content.toLowerCase().includes(queryLower)) continue;

                  const matchingLines = content
                    .split("\n")
                    .map((line, index) => ({ line: index + 1, text: line.trim() }))
                    .filter((line) => line.text.toLowerCase().includes(queryLower))
                    .slice(0, 3);

                  results.push({ file, matchingLines });
                }

                return JSON.stringify({
                  success: true,
                  query: args.query,
                  results: results.length > 0 ? results : "No matches found",
                });
              }

              case "add": {
                if (!args.content) {
                  return JSON.stringify({ success: false, error: "content is required for add" });
                }

                mkdirSync(memoryDir, { recursive: true });
                const indexPath = join(memoryDir, "MEMORY.md");
                const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8").trim() : "";
                const updated = existing ? `${existing}\n\n${args.content.trim()}\n` : `${args.content.trim()}\n`;
                writeFileSync(indexPath, updated, "utf8");
                return JSON.stringify({ success: true, path: indexPath });
              }

              case "update": {
                if (!args.file || !args.content) {
                  return JSON.stringify({
                    success: false,
                    error: "file and content are required for update",
                  });
                }

                mkdirSync(memoryDir, { recursive: true });
                const fullPath = resolveMemoryFilePath(memoryDir, args.file);
                if (!fullPath) {
                  return JSON.stringify({
                    success: false,
                    error: "file must stay inside the Claude memory directory",
                  });
                }

                mkdirSync(dirname(fullPath), { recursive: true });
                writeFileSync(fullPath, args.content, "utf8");
                return JSON.stringify({ success: true, path: fullPath });
              }

              default:
                return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
            }
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },
  };
};

export const _internal = {
  buildCompactionMemoryContext,
  buildInitialMemoryContext,
  encodeProjectPath,
  findClaudeMemoryDir,
  getToolFilePath,
  isPathInsideDirectory,
  readAllMemoryFiles,
  resolveMemoryFilePath,
  resolveOptions,
  trimIndex,
};

export default {
  id: "opencode-claude-memory",
  server: ClaudeMemoryPlugin,
};
