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

  const exactMemoryDir = join(root, _internal.sanitizePath(exactProject), "memory");
  const gitMemoryDir = join(root, _internal.sanitizePath("/Users/demo/project-b"), "memory");
  const legacyGitMemoryDir = join(root, _internal.encodeProjectPath("/Users/demo/project-b"), "memory");

  mkdirSync(exactMemoryDir, { recursive: true });
  mkdirSync(legacyGitMemoryDir, { recursive: true });

  assert.equal(
    _internal.findClaudeMemoryDir(exactProject, root, {
      resolveCanonicalRoot: () => exactProject,
    }),
    exactMemoryDir,
  );
  assert.equal(
    _internal.findClaudeMemoryDir(gitProject, root, {
      resolveCanonicalRoot: () => "/Users/demo/project-b",
    }),
    legacyGitMemoryDir,
  );

  mkdirSync(gitMemoryDir, { recursive: true });
  assert.equal(
    _internal.findClaudeMemoryDir(gitProject, root, {
      resolveCanonicalRoot: () => "/Users/demo/project-b",
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

  assert.match(context, /# Auto Memory/);
  assert.match(context, /### MEMORY\.md/);
  assert.match(context, /### topic\.md/);
});

test("readAllMemoryFiles includes nested topic files", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "claude-memory-recursive-"));
  mkdirSync(join(memoryDir, "nested"), { recursive: true });
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Index");
  writeFileSync(join(memoryDir, "nested", "topic.md"), "nested topic");

  const files = _internal.readAllMemoryFiles(memoryDir);

  assert.equal(files.topics["nested/topic.md"], "nested topic");
});

test("resolveMemoryFilePath rejects escaping the memory directory", () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "claude-memory-safety-"));

  assert.equal(_internal.resolveMemoryFilePath(memoryDir, "topic.md"), join(memoryDir, "topic.md"));
  assert.equal(_internal.resolveMemoryFilePath(memoryDir, "../outside.md"), null);
});

test("shouldIgnoreMemoryContext matches direct ignore-memory requests", () => {
  assert.equal(_internal.shouldIgnoreMemoryContext("ignore memory for this answer"), true);
  assert.equal(_internal.shouldIgnoreMemoryContext("answer without memory"), true);
  assert.equal(_internal.shouldIgnoreMemoryContext("use memory normally"), false);
});
