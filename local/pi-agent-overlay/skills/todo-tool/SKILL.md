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

```
todo({ action: "create", subject: "Investigate X" }) → id=1
todo({ action: "create", subject: "Design Y", blockedBy: [1] })
todo({ action: "create", subject: "Implement Y" }, blockedBy: [2])
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
