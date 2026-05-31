---
name: todo-tool
description: Use when implementing multi-step work with three or more phases, tracking task lists during feature development, debugging complex issues requiring sequential investigation steps, or before executing implementation plans that need structured task breakdown. Also use for dependency tracking across interdependent tasks.
---

# todo-tool

## Overview

Pi's built-in `todo` tool — powered by `@juicesharp/rpiv-todo` (v1.12.0). A 4-state task machine with dependency tracking that survives `/reload` and conversation compaction via branch replay. Always use this for any multi-step work; never manage tasks ad-hoc in chat.

**Core principle:** If a task needs more than two steps, it belongs on the todo list. This reduces context waste (model doesn't need to remember what's pending) and makes progress transparent via the live overlay above the editor.

## States & Transitions

```
pending → in_progress → completed → deleted (terminal)
any       ↖              ↑
```

- `delete` retains a tombstone so historic `blockedBy` references still resolve — don't clear a list mid-flight, that breaks dependency chains.

## Quick Reference

| Action | Required fields | Notes |
|--------|----------------|-------|
| `create` | `subject`, `action="create"` | Returns `{ id }` — save for deps |
| `update` | `id`, `action="update"` | Set fields to change only |
| `list` | `action="list"` | Optional: `status=` filter, `includeDeleted=true` |
| `get` | `id`, `action="get"` | Single task snapshot |
| `delete` | `id`, `action="delete"` | Tombstone — not gone-gone |
| `clear` | `action="clear"` | Wipes all active tasks |

## Usage Patterns

### Creating initial breakdown (before any implementation)

For substantial work, create one todo for each required workflow phase before
subagent execution or source mutation:

- `investigate`: gather facts and inspect relevant files/logs/current state
- `plan`: decide approach, constraints, acceptance checks, and handoff shape
- `execute`: implement or delegate the approved change
- `review`: inspect the diff/output for correctness, maintainability, regressions
- `verify`: run checks and confirm evidence before completion/commit

Each phase todo MUST include `subject`, a concrete `description`, an
`activeForm`, and `metadata.phase` with exactly one of the phase names above.
The parent session owns these phase todos. Delegated workers should report
progress and evidence back into the parent handoff; they should not satisfy the
parent harness by creating isolated worker-only phase todos unless the parent
explicitly asked them to manage a separate todo list.

```
todo({
  action: "create",
  subject: "Investigate current workflow guard",
  description: "Read the workflow guard, existing tests, and live Pi overlay state to identify the behavior that must change.",
  activeForm: "investigating workflow guard behavior",
  metadata: { phase: "investigate" }
}) → id=1

todo({
  action: "create",
  subject: "Plan phase-aware todo enforcement",
  description: "Define the required todo phases, blocking points, and test cases before changing the guard implementation.",
  activeForm: "planning phase-aware todo enforcement",
  blockedBy: [1],
  metadata: { phase: "plan" }
}) → id=2

todo({
  action: "create",
  subject: "Implement phase-aware guard checks",
  description: "Change the workflow guard so subagent execution, source mutation, and commit actions depend on the required todo phase states.",
  activeForm: "implementing phase-aware guard checks",
  blockedBy: [2],
  metadata: { phase: "execute" }
}) → id=3

todo({
  action: "create",
  subject: "Review guard behavior",
  description: "Review the changed guard and tests for incorrect blocking, bypasses, and stale documentation.",
  activeForm: "reviewing guard behavior",
  blockedBy: [3],
  metadata: { phase: "review" }
}) → id=4

todo({
  action: "create",
  subject: "Verify workflow guard",
  description: "Run the focused workflow guard tests, type check the extension, sync the live overlay, and verify the live tests.",
  activeForm: "verifying workflow guard behavior",
  blockedBy: [4],
  metadata: { phase: "verify" }
}) → id=5
```

### Updating a task in flight

```
todo({ action: "update", id: 1, status: "in_progress", activeForm: "investigating X" })
// ... do work ...
todo({ action: "update", id: 1, status: "completed" })
```

### Listing (for verification or /todos override)

```
todo({ action: "list", status: "in_progress" })
todo({ action: "list", includeDeleted: true })   // audit trail
```

### Adding/removing dependencies mid-flight

```
todo({ action: "update", id: 3, addBlockedBy: [5] })     // new dependency
todo({ action: "update", id: 4, removeBlockedBy: [2] })   // dep resolved externally
```

## When to ALWAYS Use

- Before ANY file read that is part of a task, investigation, or research purpose (not idle browsing)
- Before any code analysis, debugging, or bug hunting
- Even for simulations, dry runs, and hypothetical walkthroughs
- The act of reading files **with PURPOSE** counts as work — requires todos first
- Before planning changes (even if no code changes ultimately happen)
- When the skill description matches: "debugging complex issues requiring sequential investigation steps"
- For substantial work, create all five phase todos before launching subagents or mutating files.
- Before source edits, mark the `execute` phase todo `in_progress`.
- Before committing or pushing, complete the `review` and `verify` phase todos.

## When NOT to Use

- Single trivial tasks (rename a variable, fix a typo) — just do them
- Tasks spanning multiple sessions/projects — the todo list is session-scoped (branch-replay limited to current conversation)
- Permanent task management — for cross-session tracking use external tools (Jira, GitHub Issues)

## Common Mistakes

1. **Creating tasks without IDs** — always capture the returned `id` from `create` before setting up `blockedBy`. The tool returns `{ id }` in its `details.tasks` array.

2. **Using clear mid-implementation** — clears everything including tombstones, breaking `blockedBy` chains. Use targeted `update` instead.

3. **Setting status backward** — only `pending → in_progress` and either → `completed`. Cannot go `in_progress → pending` without going through completed first. (Actually: the schema shows `pending ⇄ in_progress` as bidirectional, but best practice is forward-only.)

4. **Forgetting activeForm** — this present-continuous label appears on the overlay while a task is `in_progress`. Without it the overlay shows nothing useful during work.

5. **Batching all completions** — update tasks to completed immediately after finishing each one, not at the end. This keeps the overlay accurate and lets dependent tasks become unblocked visibly.
6. **Flat plans without descriptions** — subjects alone are not enough. Every todo needs a `description` with at least 1-2 sentences explaining the concrete task. A plan of bare subjects (e.g. "Analyze DEX files") is useless; expand each to what exactly will be read, compared, and checked.
7. **Missing `blockedBy` dependencies** — when tasks depend on each other (e.g. analysis before fix, verification after implementation), model these through `blockedBy`. Do not create all todos as parallel independents when they are sequential.
8. **Forgotten verification round** — before closing any work session, a "verification" todo MUST be created and executed. Re-check every factual claim against the source files, cite evidence (file paths, line numbers, commit hashes), separate facts from assumptions, and mark unverified claims as such. This is mandatory for every analysis, bug hunt, code review, and feature task.
9. **Missing phase metadata** — substantial-work todos without `metadata.phase` do not satisfy the harness. Use exactly `investigate`, `plan`, `execute`, `review`, or `verify`.
10. **Skipping lifecycle status** — creating todos is not enough. Mark `execute` as `in_progress` before edits, and complete `review` plus `verify` before commit/push.

## Tips

- Use `metadata` for arbitrary key-value pairs (e.g., `{ metadata: { "tech-debt": true } }`)
- Pass `null` as a value when updating to delete a specific metadata key
- The `/todos` slash command provides a human-readable grouped list; the `todo({ action: "list" })` tool call returns structured data
- Completed tasks stay visible on the overlay until the next agent response starts, then auto-hide

## Schema (full)

```
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",
  // create-only
  subject?: string,
  blockedBy?: number[],
  // create + update
  description?: string,
  activeForm?: string,
  owner?: string,
  metadata?: Record<string, unknown>,
  // update-only
  addBlockedBy?: number[],
  removeBlockedBy?: number[],
  // update / get / delete
  id?: number,
  // update (target) or list (filter)
  status?: "pending" | "in_progress" | "completed" | "deleted",
  // list-only
  includeDeleted?: boolean,
})
```
