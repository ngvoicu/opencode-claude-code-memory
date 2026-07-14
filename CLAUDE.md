# CLAUDE.md — opencode-claude-code-memory

Byte-identical in `CLAUDE.md` and `AGENTS.md`. Read `../CLAUDE.md` (workspace identity hub) first.

An **OpenCode plugin** (plain Node, `index.js`) that shares Claude Code's local memory with OpenCode: loads Claude Code memory into OpenCode sessions, lets OpenCode read/update the same files, and keeps that shared memory available across longer conversations. See `README.md` for usage.

## Conventions

- origin = NAS (`ssh://zeenas/volume1/git/ngvoicu/opencode-claude-code-memory.git`); add a GitHub upstream only if/when it goes public.
- Tests in `test/` — run them after changes (`npm test`).
- It manipulates the user's real `~/.claude` memory files — be conservative: never delete or rewrite memory content wholesale; additive edits only, and respect Claude Code's memory file format (frontmatter + MEMORY.md index).
