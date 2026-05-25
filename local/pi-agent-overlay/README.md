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

## Upstream Update Flow

```bash
git fetch upstream
git merge upstream/main
node --experimental-strip-types local/pi-agent-overlay/extensions/hermes-brain-provider.test.mjs
node --experimental-strip-types --check local/pi-agent-overlay/extensions/hermes-brain-provider/index.ts
node scripts/sync-pi-agent-overlay.mjs
```

If upstream changes conflict with this overlay, resolve the overlay files in
this directory first, then sync.
