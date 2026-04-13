import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { _internal } from "../index.js";

test("resolveOptions applies sane defaults and overrides", () => {
  const config = _internal.resolveOptions({
    autoReview: true,
    initialLoadMode: "index",
    memoryRoot: "/tmp/claude-projects",
  });

  assert.equal(config.autoReview, true);
  assert.equal(config.initialLoadMode, "index");
  assert.equal(config.injectMode, "once");
  assert.equal(config.memoryRoot, "/tmp/claude-projects");
});

test("findClaudeMemoryDir prefers exact project match and falls back to git root", () => {
  const root = mkdtempSync(join(tmpdir(), "claude-memory-root-"));
  const exactProject = "/Users/demo/project-a";
  const gitProject = "/Users/demo/project-b/subdir";

  const exactMemoryDir = join(root, _internal.encodeProjectPath(exactProject), "memory");
  const gitMemoryDir = join(root, _internal.encodeProjectPath("/Users/demo/project-b"), "memory");

  mkdirSync(exactMemoryDir, { recursive: true });
  mkdirSync(gitMemoryDir, { recursive: true });

  assert.equal(_internal.findClaudeMemoryDir(exactProject, root), exactMemoryDir);
  assert.equal(
    _internal.findClaudeMemoryDir(gitProject, root, {
      resolveGitRoot: () => "/Users/demo/project-b",
    }),
    gitMemoryDir,
  );
});

test("buildInitialMemoryContext includes topic files in full mode", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "claude-memory-context-"));
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Index\n\n- test");
  writeFileSync(join(memoryDir, "topic.md"), "saved topic");

  const context = _internal.buildInitialMemoryContext(memoryDir, {
    initialLoadMode: "full",
  });

  assert.match(context, /Claude Code Memory/);
  assert.match(context, /### MEMORY\.md/);
  assert.match(context, /### topic\.md/);
});

test("resolveMemoryFilePath rejects escaping the memory directory", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "claude-memory-safety-"));

  assert.equal(_internal.resolveMemoryFilePath(memoryDir, "topic.md"), join(memoryDir, "topic.md"));
  assert.equal(_internal.resolveMemoryFilePath(memoryDir, "../outside.md"), null);
});
