import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCommandPlan, buildPrivatePatternSource, parseArgs, privatePatternSource } from "./sync-pi-upstream.mjs";

test("builds the safe upstream sync plan without pushing by default", () => {
	const plan = buildCommandPlan({ push: false });
	const commands = plan.map((step) => `${step.command} ${step.args.join(" ")}`);

	assert.deepEqual(commands, [
		"git fetch upstream",
		"git merge --ff-only upstream/main",
		"rg -n -I -e (/home/[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|gho_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{8,}|BEGIN [A-Z ]*PRIVATE KEY) local/pi-agent-overlay scripts/sync-pi-agent-overlay.mjs",
		"npm run check",
		"node --experimental-strip-types local/pi-agent-overlay/extensions/hermes-brain-provider.test.mjs",
		"node --experimental-strip-types --check local/pi-agent-overlay/extensions/hermes-brain-provider/index.ts",
		"node --check scripts/sync-pi-agent-overlay.mjs",
		"node scripts/sync-pi-agent-overlay.mjs",
	]);
});

test("adds git push only when explicitly requested", () => {
	const plan = buildCommandPlan({ push: true });
	const last = plan.at(-1);

	assert.deepEqual(last, {
		command: "git",
		args: ["push", "origin", "main"],
		kind: "normal",
		label: "Push updated fork",
	});
});

test("parses only the supported push flag", () => {
	assert.deepEqual(parseArgs([]), { push: false });
	assert.deepEqual(parseArgs(["--push"]), { push: true });
	assert.throws(() => parseArgs(["--force"]), /Unsupported option/);
});

test("private scan pattern covers known local leak markers", () => {
	const pattern = new RegExp(privatePatternSource);

	for (const marker of [
		"/home/example",
		"user@example.test",
		"gho_example",
		"github_pat_example",
		"sk-12345678",
		"BEGIN OPENSSH PRIVATE KEY",
	]) {
		assert.match(marker, pattern, marker);
	}
});

test("private scan pattern can be extended with local project markers", () => {
	const pattern = new RegExp(buildPrivatePatternSource("ProjectInternal|codeword"));

	assert.match("ProjectInternal", pattern);
	assert.match("codeword", pattern);
});
