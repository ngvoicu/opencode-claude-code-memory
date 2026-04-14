import { tool } from "@opencode-ai/plugin";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";

const DEFAULT_OPTIONS = Object.freeze({
  injectMode: "once",
  initialLoadMode: "full",
  compactionMode: "index",
  autoReview: true,
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
const AUTO_MEMORY_HEADER = "# Auto Memory";
const MAX_SANITIZED_LENGTH = 200;

function encodeProjectPath(dir) {
  return ("-" + dir.replace(/\//g, "-")).replace(/^-+/, "-");
}

function defaultMemoryRoot() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
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
    memoryRoot: resolveStringOption(rawOptions.memoryRoot, defaultMemoryRoot()),
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

function djb2Hash(str) {
  let hash = 0;
  for (let index = 0; index < str.length; index += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(index)) | 0;
  }
  return hash;
}

function sanitizePath(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`;
}

function findGitRoot(startPath) {
  let current = resolve(startPath);
  const root = current.substring(0, current.indexOf(sep) + 1) || sep;

  while (true) {
    try {
      const gitPath = join(current, ".git");
      const stats = statSync(gitPath);
      if (stats.isDirectory() || stats.isFile()) {
        return current.normalize("NFC");
      }
    } catch {}

    if (current === root) break;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function resolveCanonicalRoot(gitRoot) {
  try {
    const gitPath = join(gitRoot, ".git");
    const stats = statSync(gitPath);
    if (stats.isDirectory()) {
      return gitRoot.normalize("NFC");
    }

    const gitContent = readFileSync(gitPath, "utf8").trim();
    if (!gitContent.startsWith("gitdir:")) {
      return gitRoot.normalize("NFC");
    }

    const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim());
    const commonDir = resolve(
      worktreeGitDir,
      readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim(),
    );

    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return gitRoot.normalize("NFC");
    }

    const backlink = realpathSync(readFileSync(join(worktreeGitDir, "gitdir"), "utf8").trim());
    if (backlink !== join(realpathSync(gitRoot), ".git")) {
      return gitRoot.normalize("NFC");
    }

    if (commonDir.endsWith(`${sep}.git`)) {
      return dirname(commonDir).normalize("NFC");
    }

    return commonDir.normalize("NFC");
  } catch {
    return gitRoot.normalize("NFC");
  }
}

function findCanonicalGitRoot(startPath) {
  const gitRoot = findGitRoot(startPath);
  if (!gitRoot) return null;
  return resolveCanonicalRoot(gitRoot);
}

function resolveClaudeMemoryDir(
  projectDir,
  memoryRoot,
  { resolveCanonicalRoot: resolveProjectRoot = findCanonicalGitRoot } = {},
) {
  const canonicalRoot = resolveProjectRoot(projectDir) ?? projectDir;
  return join(memoryRoot, sanitizePath(canonicalRoot), "memory");
}

function findLegacyClaudeMemoryDir(
  projectDir,
  memoryRoot,
  { exists = existsSync, resolveCanonicalRoot: resolveProjectRoot = findCanonicalGitRoot } = {},
) {
  const candidates = [join(memoryRoot, encodeProjectPath(projectDir), "memory")];
  const canonicalRoot = resolveProjectRoot(projectDir);
  if (canonicalRoot && canonicalRoot !== projectDir) {
    candidates.push(join(memoryRoot, encodeProjectPath(canonicalRoot), "memory"));
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  return null;
}

function findClaudeMemoryDir(
  projectDir,
  memoryRoot,
  { exists = existsSync, resolveCanonicalRoot: resolveProjectRoot = findCanonicalGitRoot } = {},
) {
  const preferredPath = resolveClaudeMemoryDir(projectDir, memoryRoot, {
    resolveCanonicalRoot: resolveProjectRoot,
  });
  if (exists(preferredPath)) return preferredPath;

  const legacyPath = findLegacyClaudeMemoryDir(projectDir, memoryRoot, {
    exists,
    resolveCanonicalRoot: resolveProjectRoot,
  });
  if (legacyPath) return legacyPath;

  return null;
}

function listMarkdownFiles(memoryDir, relativeDir = "") {
  const currentDir = relativeDir ? join(memoryDir, relativeDir) : memoryDir;
  const results = [];

  try {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;

      if (entry.isDirectory()) {
        results.push(...listMarkdownFiles(memoryDir, relativePath));
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(relativePath);
      }
    }
  } catch {}

  return results;
}

function readAllMemoryFiles(memoryDir) {
  if (!memoryDir || !existsSync(memoryDir)) return { index: null, topics: {} };

  const indexPath = join(memoryDir, "MEMORY.md");
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;

  const topics = {};
  for (const relativePath of listMarkdownFiles(memoryDir)) {
    if (relativePath === "MEMORY.md") continue;

    try {
      topics[relativePath] = readFileSync(join(memoryDir, relativePath), "utf8");
    } catch {}
  }

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

  let memoryContext = `${AUTO_MEMORY_HEADER}\n\n## Claude Code Memory\n\n`;
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

function shouldIgnoreMemoryContext(query) {
  if (process.env.OPENCODE_MEMORY_IGNORE === "1") return true;
  if (!query) return false;

  const normalized = query.toLowerCase();
  return (
    /(ignore|don't use|do not use|without|skip)\s+(the\s+)?memory/.test(normalized) ||
    /memory\s+(should be|must be)?\s*ignored/.test(normalized)
  );
}

function extractUserQuery(message) {
  if (!message || typeof message !== "object") return undefined;

  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.parts)) return undefined;

  const text = message.parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || undefined;
}

function getLastUserQuery(messages) {
  if (!Array.isArray(messages)) return {};

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = typeof message?.info?.role === "string" ? message.info.role : message?.role;
    if (role !== "user") continue;

    const query = extractUserQuery(message);
    const sessionID =
      typeof message?.info?.sessionID === "string"
        ? message.info.sessionID
        : typeof message?.sessionID === "string"
          ? message.sessionID
          : undefined;

    return { query, sessionID };
  }

  return {};
}

function isAutoMemoryPart(part) {
  return (
    !!part &&
    typeof part === "object" &&
    typeof part.text === "string" &&
    part.text.includes(AUTO_MEMORY_HEADER)
  );
}

function getSessionIDFromInput(input) {
  if (!input || typeof input !== "object") return undefined;
  return typeof input.sessionID === "string" ? input.sessionID : undefined;
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
    ignoreMemoryContext: false,
    lastUserQuery: undefined,
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
    memoryDirCache =
      findClaudeMemoryDir(directory, config.memoryRoot) ??
      resolveClaudeMemoryDir(directory, config.memoryRoot);
    return memoryDirCache;
  }

  function logError(scope, error) {
    if (!config.debug) return;
    console.error(`[opencode-claude-code-memory] ${scope}`, error);
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
    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = Array.isArray(output.messages) ? output.messages : [];
      const { query, sessionID } = getLastUserQuery(messages);
      if (!sessionID) return;

      const state = getSessionState(sessionState, sessionID);
      state.lastUserQuery = query;
      state.ignoreMemoryContext = shouldIgnoreMemoryContext(query);

      if (!state.ignoreMemoryContext) return;

      output.messages = messages
        .map((message) => {
          const role =
            typeof message?.info?.role === "string" ? message.info.role : typeof message?.role === "string" ? message.role : "";
          if (role !== "system" || !Array.isArray(message.parts)) return message;

          const parts = message.parts.filter((part) => !isAutoMemoryPart(part));
          return { ...message, parts };
        })
        .filter((message) => !Array.isArray(message.parts) || message.parts.length > 0);
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = getSessionIDFromInput(input);
      if (!sessionID) return;

      const state = getSessionState(sessionState, sessionID);
      if (state.ignoreMemoryContext) return;
      if (config.injectMode === "once" && state.loaded) return;

      const memoryDir = getMemoryDir();

      try {
        const memoryContext = buildInitialMemoryContext(memoryDir, config);
        if (!memoryContext) return;

        output.system.push(memoryContext);
        state.loaded = true;

        if (config.showLoadToast) {
          await showToast("Memory", "Claude memory loaded for this session", "info", 2000);
        }
      } catch (error) {
        logError("experimental.chat.system.transform", error);
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
      const sessionID = getSessionIDFromInput(_input);
      if (sessionID && getSessionState(sessionState, sessionID).ignoreMemoryContext) return;

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
  findCanonicalGitRoot,
  getToolFilePath,
  isPathInsideDirectory,
  listMarkdownFiles,
  readAllMemoryFiles,
  resolveClaudeMemoryDir,
  resolveMemoryFilePath,
  resolveOptions,
  sanitizePath,
  shouldIgnoreMemoryContext,
  trimIndex,
};

export default {
  id: "opencode-claude-code-memory",
  server: ClaudeMemoryPlugin,
};
