#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repoRoot, "local", "pi-agent-overlay");
const home = process.env.HOME;
if (!home && !process.env.PI_AGENT_HOME) {
	throw new Error("Set HOME or PI_AGENT_HOME before syncing the Pi agent overlay.");
}
const targetRoot = resolve(process.env.PI_AGENT_HOME ?? join(home ?? "", ".pi", "agent"));

const copies = [
	["APPEND_SYSTEM.md", "APPEND_SYSTEM.md"],
	["settings.json", "settings.json"],
	["models.json", "models.json"],
	["extensions/hermes-brain-provider/index.ts", "extensions/hermes-brain-provider/index.ts"],
	["extensions/hermes-brain-provider.test.mjs", "extensions/hermes-brain-provider.test.mjs"],
	["skills/todo-tool/SKILL.md", "skills/todo-tool/SKILL.md"],
	["themes/rnk-dark.json", "themes/rnk-dark.json"],
	["npm/package.json", "npm/package.json"],
	["npm/package-lock.json", "npm/package-lock.json"],
	["npm/.gitignore", "npm/.gitignore"],
];

for (const [from, to] of copies) {
	const source = join(sourceRoot, from);
	const target = join(targetRoot, to);
	await mkdir(dirname(target), { recursive: true });
	await rm(target, { force: true, recursive: true });
	await cp(source, target, { recursive: true });
	console.log(`${from} -> ${target}`);
}

console.log(`Synced Pi agent overlay to ${targetRoot}`);
