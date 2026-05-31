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
- `extensions/workflow-guard/`: local workflow gate that injects workflow
  instructions, preselects subagent mode for substantial work, requires described
  todos before substantial execution, and blocks premature mutations.
- `extensions/workflow-guard.test.mjs`: regression tests for workflow gating.
- `chains/`: saved `pi-subagents` workflows copied into `~/.pi/agent/chains`.
- `skills/todo-tool/SKILL.md`: local todo tool skill instructions.
- `themes/rnk-dark.json`: global custom Pi theme.
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

Subagent workflow model:

- The main Pi session is the persistent supervisor. It owns user communication,
  decisions, accepted scope, final synthesis, and completion claims.
- `workflow-guard` adds a structural gate for substantial work: the harness
  preselects subagent mode, requires described phase todos for `investigate`,
  `plan`, `execute`, `review`, and `verify`, blocks subagent execution until
  those phase todos exist, and blocks `edit`, `write`, `append`, or obvious
  source-mutating bash commands until the `execute` todo is `in_progress`.
  It also blocks `git commit` and `git push` until `review` and `verify` are
  completed.
- The gate also listens to streaming tool-call previews, so `edit`, `write`,
  and `append` can be rejected as soon as the tool name appears, before a model
  spends a long response generating huge file contents that will be denied.
- Explicit single-file artifact wording is treated as an artifact constraint,
  not as an automatic small/direct escape hatch. Polished apps, games, websites,
  dashboards, and interactive tools remain substantial even when delivered as
  one file.
- `workflow_decision` is still available to explicitly declare or adjust workflow
  mode, but substantial default routing no longer depends on the model deciding
  to call it.
- Explicit user escape hatches such as `mach direkt`, `ohne subagents`, or
  `no subagents` allow direct mode.
- Read-only inspection remains free: `read`, `grep`, `find`, `ls`, read-only
  bash, todo/status/list tools, and subagent discovery/status are not gated.
- Subagents are disposable focused sessions. Prefer them for scouting, context
  building, planning, research, review, validation, and larger implementation
  handoffs.
- Implementation handoffs should use the `worker` subagent. Execution skills are
  passed through the subagent `skill` override, for example `agent: "worker"`
  with `skill: ["frontend-design"]`; skill names are not valid implementation
  agent names.
- Fresh-context defaults are set for `scout`, `researcher`, `context-builder`,
  `planner`, `reviewer`, and `delegate` to reduce parent context bloat.
- `worker` and `oracle` stay forked by default because they often need the
  parent session's approved decisions and trajectory.
- `reviewer` is read-only by default in this overlay. Fixes should flow through
  the main session's synthesis and a single `worker` writer pass.
- Normal writes/appends should stay single-threaded in one active worktree.
  Parallelize reading, research, review, and validation; use worktrees only when
  parallel writers are explicitly intended.
- Saved chains:
  - `investigate-plan`: fresh scout/context-builder fanout followed by a plan.
  - `implement-handoff`: forked single-worker implementation with acceptance
    evidence.
  - `parallel-review`: fresh read-only review fanout for correctness,
    validation, and simplicity.

Hermes context model:

- The static fallback context is `150000` tokens per Pi session, matching a
  conservative half of a two-slot roughly-300k Hermes Brain setup.
- The provider extension still tries runtime detection through Hermes
  `/props`, `/slots`, and `/v1/models`; detected `n_ctx_slot` values override
  the static fallback.
- Main-session history should only be reduced by Pi compaction. Worker and
  review context should be discarded naturally by using fresh/forked child
  sessions and compact handoffs instead of copying full transcripts back.

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
node --experimental-strip-types local/pi-agent-overlay/extensions/workflow-guard.test.mjs
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

## Install Fork Core

The `pi` executable should also point at this fork, not the published npm
package, when local core changes matter.

From the repository root:

```bash
npm run build
node scripts/install-pi-fork-core.mjs
```

The script rewrites the active npm-global `pi` symlink to
`packages/coding-agent/dist/cli.js` in this checkout. If a previous npm-global
symlink exists, it is saved as `pi.upstream-npm` next to the active executable.

Verify:

```bash
readlink -f "$(which pi)"
pi --version
```

After this, do not use `pi update --self` for normal maintenance. Update the
core by merging upstream into the fork, rebuilding, and rerunning the install
script. Package updates remain separate and should be mirrored into
`local/pi-agent-overlay/npm/package.json` and `package-lock.json`.

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
