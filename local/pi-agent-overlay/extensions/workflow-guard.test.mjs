import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyPromptForWorkflow,
	evaluateMutationGate,
	findSkillLocation,
	isMutatingToolCall,
	isSubagentExecution,
	validateWorkflowDecision,
} from "./workflow-guard/index.ts";

test("classifies substantial implementation prompts", () => {
	const result = classifyPromptForWorkflow("Implementiere bitte eine harness extension mit tests und sync in die live pi config.");

	assert.equal(result.taskSize, "substantial");
	assert.equal(result.explicitDirect, false);
});

test("classifies explicit single-file artifact prompts as small", () => {
	const result = classifyPromptForWorkflow(
		"Create a polished galactic colony browser game as a single HTML file in galactic-colony.html.",
	);

	assert.equal(result.taskSize, "small");
	assert.equal(result.explicitDirect, true);
});

test("classifies delegated subagent prompts as direct execution", () => {
	const result = classifyPromptForWorkflow(
		[
			"Task: You are a delegated subagent running from a fork of the parent session.",
			"Your sole job is to execute the task below and return a focused result.",
			"Task: Implement the approved feature across several files and run validation.",
		].join("\n\n"),
	);

	assert.equal(result.taskSize, "small");
	assert.equal(result.explicitDirect, true);
});

test("detects explicit direct escape hatch", () => {
	const result = classifyPromptForWorkflow("mach direkt, ohne subagents: ändere diese eine README-Zeile");

	assert.equal(result.explicitDirect, true);
});

test("does not gate read-only inspection calls", () => {
	assert.equal(isMutatingToolCall({ toolName: "read", input: { path: "src/app.ts" } }), false);
	assert.equal(isMutatingToolCall({ toolName: "bash", input: { command: "git diff -- src/app.ts" } }), false);
});

test("gates source mutations without workflow decision", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("Implementiere ein neues Feature mit Tests."),
			decision: undefined,
			subagentStarted: false,
		},
		{ toolName: "edit", input: { path: "src/app.ts" } },
	);

	assert.equal(result.block, true);
	assert.match(result.reason, /workflow_decision/);
});

test("treats append as a source mutation", () => {
	assert.equal(isMutatingToolCall({ toolName: "append", input: { path: "src/app.ts", content: "x" } }), true);
});

test("allows small direct tasks without an explicit workflow decision", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("Create a single HTML file game in galactic-colony.html."),
			decision: undefined,
			subagentStarted: false,
		},
		{ toolName: "write", input: { path: "galactic-colony.html", content: "<!doctype html>" } },
	);

	assert.equal(result.block, false);
});

test("blocks substantial direct mode unless the user explicitly asked for direct work", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("Refactor the authentication flow and update tests."),
			decision: {
				mode: "direct",
				taskSize: "substantial",
				skills: ["using-superpowers", "test-driven-development"],
				reason: "I can do it directly.",
			},
			subagentStarted: false,
		},
		{ toolName: "write", input: { path: "src/auth.ts" } },
	);

	assert.equal(result.block, true);
	assert.match(result.reason, /subagent/);
});

test("allows direct mode for explicit direct prompts", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("mach direkt ohne subagents: ändere diese kleine Config-Zeile"),
			decision: {
				mode: "direct",
				taskSize: "small",
				skills: ["using-superpowers"],
				reason: "User requested direct work for a small edit.",
			},
			subagentStarted: false,
		},
		{ toolName: "edit", input: { path: "settings.json" } },
	);

	assert.equal(result.block, false);
});

test("blocks substantial subagent mode before a subagent execution", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("Build a new verification workflow."),
			decision: {
				mode: "subagent",
				taskSize: "substantial",
				skills: ["using-superpowers", "subagent-driven-development"],
				reason: "Needs context and review.",
			},
			subagentStarted: false,
		},
		{ toolName: "edit", input: { path: "src/workflow.ts" } },
	);

	assert.equal(result.block, true);
	assert.match(result.reason, /Run a subagent/);
});

test("allows substantial subagent mode after a subagent execution", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("Build a new verification workflow."),
			decision: {
				mode: "subagent",
				taskSize: "substantial",
				skills: ["using-superpowers", "subagent-driven-development"],
				reason: "Needs context and review.",
			},
			subagentStarted: true,
		},
		{ toolName: "edit", input: { path: "src/workflow.ts" } },
	);

	assert.equal(result.block, false);
});

test("requires workflow skills for substantial decisions", () => {
	const errors = validateWorkflowDecision({
		mode: "subagent",
		taskSize: "substantial",
		skills: [],
		reason: "Needs work.",
	});

	assert.deepEqual(errors, [
		"Substantial tasks must declare using-superpowers in skills.",
		"Substantial tasks must declare at least one execution skill.",
	]);
});

test("detects only real subagent execution calls", () => {
	assert.equal(isSubagentExecution({ toolName: "subagent", input: { agent: "scout", task: "Map context" } }), true);
	assert.equal(isSubagentExecution({ toolName: "subagent", input: { action: "list" } }), false);
	assert.equal(isSubagentExecution({ toolName: "read", input: { path: "src/app.ts" } }), false);
});

test("finds skill locations in assembled system prompt", () => {
	const prompt = [
		"<available_skills>",
		"  <skill>",
		"    <name>using-superpowers</name>",
		"    <description>Start correctly</description>",
		"    <location>/tmp/using-superpowers/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");

	assert.equal(findSkillLocation(prompt, "using-superpowers"), "/tmp/using-superpowers/SKILL.md");
});
