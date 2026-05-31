import assert from "node:assert/strict";
import { test } from "node:test";

import {
	classifyPromptForWorkflow,
	createWorkflowGuardStateForPrompt,
	evaluateMutationGate,
	evaluateToolCallGate,
	findSkillLocation,
	isMutatingToolCall,
	isSubagentExecution,
	isTodoCreateCall,
	isWorkflowSubagentExecution,
	syncTodoStateFromDetails,
	validateWorkflowDecision,
} from "./workflow-guard/index.ts";

function phaseTodo(id, phase, status = "pending") {
	return {
		id,
		subject: `${phase} task`,
		description: `Concrete ${phase} work for this task.`,
		activeForm: `${phase}ing task`,
		status,
		metadata: { phase },
	};
}

function addRequiredPhaseTodos(state, statuses = {}) {
	syncTodoStateFromDetails(state, {
		tasks: [
			phaseTodo(1, "investigate", statuses.investigate ?? "pending"),
			phaseTodo(2, "plan", statuses.plan ?? "pending"),
			phaseTodo(3, "execute", statuses.execute ?? "pending"),
			phaseTodo(4, "review", statuses.review ?? "pending"),
			phaseTodo(5, "verify", statuses.verify ?? "pending"),
		],
	});
}

test("classifies substantial implementation prompts", () => {
	const result = classifyPromptForWorkflow("Implementiere bitte eine harness extension mit tests und sync in die live pi config.");

	assert.equal(result.taskSize, "substantial");
	assert.equal(result.explicitDirect, false);
});

test("classifies substantial single-file artifact prompts as substantial", () => {
	const result = classifyPromptForWorkflow(
		"Create a polished galactic colony browser game as a single HTML file in galactic-colony.html.",
	);

	assert.equal(result.taskSize, "substantial");
	assert.equal(result.explicitDirect, false);
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

test("preselects subagent workflow for substantial prompts", () => {
	const state = createWorkflowGuardStateForPrompt(
		"Create a polished galactic colony browser game as a single HTML file in galactic-colony.html.",
	);

	assert.equal(state.classification.taskSize, "substantial");
	assert.equal(state.decision?.mode, "subagent");

	const result = evaluateMutationGate(state, { toolName: "write", input: { path: "galactic-colony.html" } });

	assert.equal(result.block, true);
	assert.match(result.reason, /Run a subagent/);
});

test("blocks streaming write previews before content arguments exist", () => {
	const state = createWorkflowGuardStateForPrompt(
		"Create a polished galactic colony browser game as a single HTML file in galactic-colony.html.",
	);

	const result = evaluateToolCallGate(state, { toolName: "write", input: {} });

	assert.equal(result.block, true);
	assert.match(result.reason, /metadata\.phase/);
	assert.match(result.reason, /investigate/);
});

test("blocks substantial subagent execution until required phase todos are created", () => {
	const state = createWorkflowGuardStateForPrompt("Implement a new workflow extension with tests.");

	const result = evaluateToolCallGate(state, { toolName: "subagent", input: { agent: "worker", task: "Implement it" } });

	assert.equal(result.block, true);
	assert.match(result.reason, /investigate/);
	assert.match(result.reason, /verify/);
});

test("allows substantial subagent execution after required phase todos", () => {
	const state = createWorkflowGuardStateForPrompt("Implement a new workflow extension with tests.");
	addRequiredPhaseTodos(state);

	const result = evaluateToolCallGate(state, { toolName: "subagent", input: { agent: "worker", task: "Implement it" } });

	assert.equal(result.block, false);
});

test("blocks using a skill name as the substantial implementation subagent", () => {
	const state = createWorkflowGuardStateForPrompt(
		"Create a polished galactic colony browser game as a single HTML file in galactic-colony.html.",
	);
	addRequiredPhaseTodos(state);

	const result = evaluateToolCallGate(state, {
		toolName: "subagent",
		input: { agent: "frontend-design", async: true },
	});

	assert.equal(result.block, true);
	assert.match(result.reason, /frontend-design/);
	assert.match(result.reason, /worker/);
	assert.match(result.reason, /skill/);
});

test("allows worker implementation subagent with a frontend-design skill override", () => {
	const state = createWorkflowGuardStateForPrompt(
		"Create a polished galactic colony browser game as a single HTML file in galactic-colony.html.",
	);
	addRequiredPhaseTodos(state);

	const result = evaluateToolCallGate(state, {
		toolName: "subagent",
		input: {
			agent: "worker",
			task: "Implement the requested polished single-file Galactic Colony browser game and report verification evidence.",
			skill: ["frontend-design"],
			async: true,
		},
	});

	assert.equal(result.block, false);
});

test("only counts todo creates with descriptions", () => {
	assert.equal(
		isTodoCreateCall({
			toolName: "todo",
			input: {
				action: "create",
				subject: "Investigate",
				description: "Read the relevant files and identify the failure mode.",
				activeForm: "investigating the failure mode",
				metadata: { phase: "investigate" },
			},
		}),
		true,
	);
	assert.equal(isTodoCreateCall({ toolName: "todo", input: { action: "create", subject: "Investigate" } }), false);
	assert.equal(
		isTodoCreateCall({
			toolName: "todo",
			input: {
				action: "create",
				subject: "Investigate",
				description: "Read files.",
				activeForm: "investigating files",
			},
		}),
		false,
	);
	assert.equal(isTodoCreateCall({ toolName: "todo", input: { action: "list" } }), false);
});

test("accepts frontend-design as a substantial execution skill", () => {
	const errors = validateWorkflowDecision({
		mode: "subagent",
		taskSize: "substantial",
		skills: ["using-superpowers", "frontend-design"],
		reason: "A polished browser game needs frontend execution.",
	});

	assert.deepEqual(errors, []);
});

test("blocks bare substantial todo creates that do not declare a phase", () => {
	const state = createWorkflowGuardStateForPrompt("Create a polished galactic colony browser game as a single HTML file.");

	const result = evaluateToolCallGate(state, {
		toolName: "todo",
		input: { action: "create", subject: "Implement Galactic Colony game" },
	});

	assert.equal(result.block, true);
	assert.match(result.reason, /metadata\.phase/);
	assert.match(result.reason, /investigate/);
});

test("allows valid substantial phase todo creates", () => {
	const state = createWorkflowGuardStateForPrompt("Create a polished galactic colony browser game as a single HTML file.");

	const result = evaluateToolCallGate(state, {
		toolName: "todo",
		input: {
			action: "create",
			subject: "Investigate game requirements",
			description: "Inspect the requested game scope and define what facts must be gathered before implementation.",
			activeForm: "investigating game requirements",
			metadata: { phase: "investigate" },
		},
	});

	assert.equal(result.block, false);
});

test("blocks source mutations until execute todo is in progress", () => {
	const state = createWorkflowGuardStateForPrompt("Implement a new workflow extension with tests.");
	addRequiredPhaseTodos(state, { execute: "pending" });
	state.subagentStarted = true;

	const result = evaluateToolCallGate(state, { toolName: "edit", input: { path: "src/workflow.ts" } });

	assert.equal(result.block, true);
	assert.match(result.reason, /execute/i);
	assert.match(result.reason, /in_progress/);
});

test("allows source mutations while execute todo is in progress", () => {
	const state = createWorkflowGuardStateForPrompt("Implement a new workflow extension with tests.");
	addRequiredPhaseTodos(state, { execute: "in_progress" });
	state.subagentStarted = true;

	const result = evaluateToolCallGate(state, { toolName: "edit", input: { path: "src/workflow.ts" } });

	assert.equal(result.block, false);
});

test("blocks commits until review and verify todos are completed", () => {
	const state = createWorkflowGuardStateForPrompt("Implement a new workflow extension with tests.");
	addRequiredPhaseTodos(state, { execute: "completed", review: "completed", verify: "pending" });
	state.subagentStarted = true;

	const result = evaluateToolCallGate(state, { toolName: "bash", input: { command: "git commit -m test" } });

	assert.equal(result.block, true);
	assert.match(result.reason, /verify/i);
});

test("allows commits after review and verify todos are completed", () => {
	const state = createWorkflowGuardStateForPrompt("Implement a new workflow extension with tests.");
	addRequiredPhaseTodos(state, { execute: "completed", review: "completed", verify: "completed" });
	state.subagentStarted = true;

	const result = evaluateToolCallGate(state, { toolName: "bash", input: { command: "git commit -m test" } });

	assert.equal(result.block, false);
});

test("treats append as a source mutation", () => {
	assert.equal(isMutatingToolCall({ toolName: "append", input: { path: "src/app.ts", content: "x" } }), true);
});

test("allows small direct tasks without an explicit workflow decision", () => {
	const result = evaluateMutationGate(
		{
			classification: classifyPromptForWorkflow("Fix one typo in README.md."),
			decision: undefined,
			subagentStarted: false,
		},
		{ toolName: "edit", input: { path: "README.md", oldText: "teh", newText: "the" } },
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

test("blocks immediate async subagent status polling", () => {
	const state = createWorkflowGuardStateForPrompt("Create a polished galactic colony browser game as a single HTML file.");
	state.blockImmediateAsyncSubagentStatus = true;

	const result = evaluateToolCallGate(state, { toolName: "subagent", input: { action: "status" } });

	assert.equal(result.block, true);
	assert.match(result.reason, /tracking overlay/);
});

test("allows subagent status when not immediately after async launch", () => {
	const state = createWorkflowGuardStateForPrompt("Create a polished galactic colony browser game as a single HTML file.");

	const result = evaluateToolCallGate(state, { toolName: "subagent", input: { action: "status" } });

	assert.equal(result.block, false);
});

test("counts only implementation subagents as satisfying the workflow handoff", () => {
	assert.equal(
		isWorkflowSubagentExecution({ toolName: "subagent", input: { agent: "worker", task: "Implement the approved plan." } }),
		true,
	);
	assert.equal(
		isWorkflowSubagentExecution({ toolName: "subagent", input: { agent: "scout", task: "Map context." } }),
		false,
	);
	assert.equal(
		isWorkflowSubagentExecution({ toolName: "subagent", input: { agent: "frontend-design", task: "Build UI." } }),
		false,
	);
	assert.equal(isWorkflowSubagentExecution({ toolName: "subagent", input: { chainName: "investigate-plan" } }), false);
	assert.equal(isWorkflowSubagentExecution({ toolName: "subagent", input: { chainName: "implement-handoff" } }), true);
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
