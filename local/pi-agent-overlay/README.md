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
- `npm/package.json` and `npm/package-lock.json`: local Pi extension dependencies.

Excluded on purpose:

- `auth.json`
- `AGENTS.md`
- `sessions/`
- `npm/node_modules/`

## Verify

From the repository root:

```bash
node --experimental-strip-types local/pi-agent-overlay/extensions/hermes-brain-provider.test.mjs
node --experimental-strip-types --check local/pi-agent-overlay/extensions/hermes-brain-provider/index.ts
```

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
