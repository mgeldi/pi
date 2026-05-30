#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const privatePatternSource =
	"(/home/[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|gho_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}|BEGIN [A-Z ]*PRIVATE KEY)";

export function buildPrivatePatternSource(extraPatternSource = "") {
	const trimmed = extraPatternSource.trim();
	return trimmed ? `${privatePatternSource}|(${trimmed})` : privatePatternSource;
}

export function parseArgs(args) {
	const parsed = { push: false };
	for (const arg of args) {
		if (arg === "--push") {
			parsed.push = true;
			continue;
		}
		throw new Error(`Unsupported option: ${arg}`);
	}
	return parsed;
}

export function buildCommandPlan({ push, scanPatternSource = privatePatternSource }) {
	const plan = [
		{ label: "Fetch upstream", command: "git", args: ["fetch", "upstream"], kind: "normal" },
		{ label: "Fast-forward merge upstream", command: "git", args: ["merge", "--ff-only", "upstream/main"], kind: "normal" },
		{
			label: "Scan overlay for local or private markers",
			command: "rg",
			args: [
				"-n",
				"-I",
				"-e",
				scanPatternSource,
				"local/pi-agent-overlay",
				"scripts/sync-pi-agent-overlay.mjs",
				"scripts/context-mode-pi-bridge-smoke.test.mjs",
			],
			kind: "inverted",
		},
		{ label: "Run repository checks", command: "npm", args: ["run", "check"], kind: "normal" },
		{
			label: "Run overlay approval-policy tests",
			command: "node",
			args: ["--experimental-strip-types", "local/pi-agent-overlay/extensions/hermes-brain-provider.test.mjs"],
			kind: "normal",
		},
		{
			label: "Check overlay provider syntax",
			command: "node",
			args: ["--experimental-strip-types", "--check", "local/pi-agent-overlay/extensions/hermes-brain-provider/index.ts"],
			kind: "normal",
		},
		{ label: "Check overlay sync script syntax", command: "node", args: ["--check", "scripts/sync-pi-agent-overlay.mjs"], kind: "normal" },
		{ label: "Sync overlay to live Pi agent", command: "node", args: ["scripts/sync-pi-agent-overlay.mjs"], kind: "normal" },
		{ label: "Run context-mode Pi bridge smoke test", command: "node", args: ["scripts/context-mode-pi-bridge-smoke.test.mjs"], kind: "normal" },
	];
	if (push) plan.push({ label: "Push updated fork", command: "git", args: ["push", "origin", "main"], kind: "normal" });
	return plan;
}

function run(command, args, options = {}) {
	console.log(`\n$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { stdio: options.capture ? "pipe" : "inherit", encoding: "utf8" });
	if (result.error) throw result.error;
	return result;
}

function ensureCleanWorktree() {
	const status = run("git", ["status", "--porcelain"], { capture: true });
	if (status.status !== 0) throw new Error("Could not inspect git status.");
	if (status.stdout.trim()) {
		throw new Error(`Worktree is dirty. Commit or stash changes before syncing upstream.\n${status.stdout.trim()}`);
	}
}

function runPlanStep(step) {
	const result = run(step.command, step.args, { capture: step.kind === "inverted" });
	if (step.kind === "inverted") {
		if (result.status === 1) return;
		if (result.status === 0) {
			throw new Error(`Private/local markers found during scan:\n${result.stdout.trim()}`);
		}
		throw new Error(result.stderr.trim() || `Command failed: ${step.command} ${step.args.join(" ")}`);
	}
	if (result.status !== 0) {
		throw new Error(`Command failed: ${step.command} ${step.args.join(" ")}`);
	}
}

export function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	ensureCleanWorktree();
	const scanPatternSource = buildPrivatePatternSource(process.env.PI_OVERLAY_PRIVATE_PATTERNS ?? "");
	for (const step of buildCommandPlan({ ...options, scanPatternSource })) {
		console.log(`\n== ${step.label} ==`);
		runPlanStep(step);
	}
	console.log("\nPi upstream sync finished.");
	if (!options.push) {
		console.log("Review the result, then push with: git push origin main");
	}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`\nERROR: ${message}`);
		process.exit(1);
	}
}
