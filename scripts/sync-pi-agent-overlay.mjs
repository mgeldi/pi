#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	["extensions/workflow-guard/index.ts", "extensions/workflow-guard/index.ts"],
	["extensions/workflow-guard.test.mjs", "extensions/workflow-guard.test.mjs"],
	["extensions/hermes-brain-provider/index.ts", "extensions/hermes-brain-provider/index.ts"],
	["extensions/hermes-brain-provider.test.mjs", "extensions/hermes-brain-provider.test.mjs"],
	["skills/todo-tool/SKILL.md", "skills/todo-tool/SKILL.md"],
	["chains", "chains"],
	["themes/rnk-dark.json", "themes/rnk-dark.json"],
	["npm/package.json", "npm/package.json"],
	["npm/package-lock.json", "npm/package-lock.json"],
	["npm/.gitignore", "npm/.gitignore"],
	["npm/scripts", "npm/scripts"],
];

for (const [from, to] of copies) {
	const source = join(sourceRoot, from);
	const target = join(targetRoot, to);
	await mkdir(dirname(target), { recursive: true });
	await rm(target, { force: true, recursive: true });
	await cp(source, target, { recursive: true });
	console.log(`${from} -> ${target}`);
}

const patchScript = join(targetRoot, "npm", "scripts", "patch-pi-subagents.mjs");
try {
	const patchModule = await import(pathToFileURL(patchScript).href);
	patchModule.patchPiSubagents();
	console.log("Applied Pi overlay npm patches");
} catch (error) {
	console.error(`Failed to apply Pi overlay npm patches: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

console.log(`Synced Pi agent overlay to ${targetRoot}`);
