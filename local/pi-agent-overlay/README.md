# Pi Agent Overlay

This directory is the source of truth for a local Pi agent overlay.

It intentionally keeps the customization as an overlay instead of patching Pi
core files. That keeps upstream merges simple: update the fork from
`earendil-works/pi`, then re-run the overlay tests and sync this directory into
`~/.pi/agent`.

## Contents

- `APPEND_SYSTEM.md`: global Pi persona.
- `settings.json`: global Pi runtime settings.
- `models.json`: Hermes Brain and Hermes Approval provider definitions.
- `extensions/hermes-brain-provider/`: local Hermes provider and approval policy.
- `extensions/hermes-brain-provider.test.mjs`: regression tests for the approval policy.
- `skills/todo-tool/SKILL.md`: local todo tool skill instructions.
- `npm/package.json` and `npm/package-lock.json`: pinned local Pi package
  dependencies.

Current package set:

- `@juicesharp/rpiv-todo`
- `@juicesharp/rpiv-ask-user-question`
- `context-mode`
- `pi-subagents`
- `pi-web-access`
- `pi-lens`
- `pi-verify`

Verification model:

- `pi-lens` stays the broad, language-aware post-write/edit feedback layer. It
  uses LSP, linters, formatters, structural rules, and turn-end checks.
- `pi-verify` adds the explicit `verify_code` tool for project-defined staged
  checks such as builds, tests, and lint commands.
- Avoid hard global build assumptions. Repositories with legacy toolchains or
  nested projects should define `.pi/verify.json` locally.

Excluded on purpose:

- `auth.json`
- `AGENTS.md`
- `sessions/`
- `npm/node_modules/`

## Approval Policy Notes

The Hermes provider keeps Pi usable for local-only development while still
guarding actions that are hard to reverse.

- Normal read-only shell/file inspection is auto-approved, including local grep
  checks over sensitive-looking names and git object inspection.
- `context-mode` read/query tools (`ctx_search`, `ctx_stats`, `ctx_doctor`) are
  auto-approved.
- `ctx_execute_file` is auto-approved when it analyzes a path inside the current
  project and the supplied code is read-only.
- `ctx_execute` shell mode is auto-approved for commands that classify as
  read-only, known verification commands, or local loopback curl calls.
- `ctx_fetch_and_index`, `ctx_index`, `ctx_upgrade`, and `ctx_purge` still ask,
  because they touch network, persistent local knowledge, upgrades, or deletion.
- `ctx_execute_file` still asks outside the project or when the supplied code
  appears to write files, spawn commands, or call external network APIs.

## Local LSP Toolchain

`pi-lens` uses local language servers when it can find them, and falls back to
its managed tool cache for npm-based servers. The live machine should have these
servers available:

- Python: `pyright-langserver`, managed under `~/.pi-lens/tools` with a
  wrapper in `~/.local/bin`.
- Rust: `rust-analyzer`, installed through `rustup component add rust-analyzer`.
- Java: `jdtls`, installed under `~/.pi-lens/jdtls` with a wrapper in
  `~/.local/bin/jdtls`.
- JavaScript/TypeScript: `typescript-language-server` plus `typescript`,
  managed under `~/.pi-lens/tools` with a wrapper in `~/.local/bin`.
- C#: `csharp-ls`, installed under `~/.pi-lens/bin` with a wrapper in
  `~/.local/bin`; the inner wrapper sets `DOTNET_ROOT=~/.dotnet` before
  starting the real apphost.
- C/C++: `clangd` from the system LLVM/Clang package.
- Bash: `bash-language-server`, managed under `~/.pi-lens/tools` with a wrapper
  in `~/.local/bin`.
- YAML: `yaml-language-server`, managed under `~/.pi-lens/tools` with a wrapper
  in `~/.local/bin`.
- JSON: `vscode-json-language-server`, managed under `~/.pi-lens/tools` with a
  wrapper in `~/.local/bin`.

Quick shell check:

```bash
command -v pyright-langserver rust-analyzer java jdtls csharp-ls clangd \
  typescript-language-server bash-language-server yaml-language-server \
  vscode-json-language-server
```

Optional user-level `pi-lens` preferences live in `~/.pi-lens/config.json`.
The current local profile keeps formatting deferred, leaves automatic warning
autofix disabled, and enables turn-end actionable warning reports with LSP code
action names.

## Verify

From the repository root:

```bash
node --experimental-strip-types local/pi-agent-overlay/extensions/hermes-brain-provider.test.mjs
node --experimental-strip-types --check local/pi-agent-overlay/extensions/hermes-brain-provider/index.ts
node scripts/context-mode-pi-bridge-smoke.test.mjs
```

Run the `context-mode` smoke from a normal local shell. The Codex sandbox can
block nested Node child-process stdio, which is the behavior that smoke checks.

## Sync To Live Pi

From the repository root:

```bash
node scripts/sync-pi-agent-overlay.mjs
```

The script copies only the versioned overlay files into `~/.pi/agent`. It does
not touch auth, sessions, or installed `node_modules`.

`~/.pi/agent` is the live runtime directory. The fork is the source of truth,
but Pi does not load files directly from the fork. Run the sync script after
changing overlay files or after merging upstream changes.

After syncing, verify the live `context-mode` bridge from a normal local shell:

```bash
node scripts/context-mode-pi-bridge-smoke.test.mjs
```

## Upstream Update Flow

Use the guarded update script for the normal workflow:

```bash
node scripts/sync-pi-upstream.mjs
```

The script requires a clean worktree and then runs:

1. `git fetch upstream`
2. `git merge --ff-only upstream/main`
3. a privacy scan for local paths, project markers, personal email fragments,
   token-like strings, and key blocks in the overlay files
4. `npm run check`
5. overlay approval-policy tests
6. TypeScript and script syntax checks
7. `node scripts/sync-pi-agent-overlay.mjs`
8. `node scripts/context-mode-pi-bridge-smoke.test.mjs`

It does not push by default. Review the result, then run:

```bash
git push origin main
```

To push as part of the guarded workflow:

```bash
node scripts/sync-pi-upstream.mjs --push
```

If upstream changes conflict with this fork, the fast-forward merge fails.
Resolve the upstream merge manually, rerun the guarded script, then push.

For local-only project names or codewords, extend the privacy scan without
committing those markers:

```bash
PI_OVERLAY_PRIVATE_PATTERNS='ProjectInternal|internal-codeword' node scripts/sync-pi-upstream.mjs
```

## Privacy Rules

Do not commit live-only or personal files:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/AGENTS.md`
- `~/.pi/agent/sessions/`
- `~/.pi/agent/npm/node_modules/`

Keep examples generic. Do not use local absolute paths, private project names,
real credentials, personal email addresses, or copied session data in this
overlay.
