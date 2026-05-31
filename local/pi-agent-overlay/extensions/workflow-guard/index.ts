import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type JsonRecord = Record<string, unknown>;

export type WorkflowMode = "direct" | "subagent";
export type WorkflowTaskSize = "small" | "substantial";
export type WorkflowTodoPhase = "investigate" | "plan" | "execute" | "review" | "verify";
export type WorkflowTodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export type WorkflowDecision = {
	mode: WorkflowMode;
	taskSize: WorkflowTaskSize;
	skills: string[];
	reason: string;
};

export type WorkflowPromptClassification = {
	taskSize: WorkflowTaskSize;
	explicitDirect: boolean;
	reason: string;
};

export type WorkflowGuardState = {
	classification: WorkflowPromptClassification;
	decision?: WorkflowDecision;
	subagentStarted: boolean;
	todoCreateCount: number;
	todoPhases: Partial<Record<WorkflowTodoPhase, WorkflowTodoStatus>>;
};

export type ToolCallSummary = {
	toolName: string;
	input: JsonRecord;
};

export type MutationGateResult = {
	block: boolean;
	reason?: string;
};

const WORKFLOW_DECISION_TOOL = "workflow_decision";
const SUBAGENT_TOOL_NAMES = new Set(["subagent", "mcp__pi-subagents__subagent"]);
const TODO_TOOL_NAMES = new Set(["todo", "todos", "mcp__rpiv-todo__todo", "mcp__todo__todo"]);
const REQUIRED_TODO_PHASES: WorkflowTodoPhase[] = ["investigate", "plan", "execute", "review", "verify"];
const EXECUTION_SKILLS = new Set([
	"brainstorming",
	"dispatching-parallel-agents",
	"executing-plans",
	"frontend-design",
	"build-web-apps:frontend-app-builder",
	"java-clean-code",
	"lsp-navigation",
	"spring-boot",
	"spring-boot-microservices",
	"spring-boot-testing",
	"spring-data-jpa",
	"spring-security",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"vaadin",
	"vaadin-testing",
	"using-git-worktrees",
	"verification-before-completion",
	"writing-plans",
]);

const READ_ONLY_BASH_PATTERNS = [
	/^\s*(?:git\s+(?:diff|status|show|log|branch|rev-parse|merge-base|ls-tree|cat-file|grep)\b)/i,
	/^\s*(?:rg|grep|find|ls|cat|sed\s+-n|head|tail|wc|stat|pwd|which|command\s+-v|tree)\b/i,
	/^\s*(?:node\s+(?:--check|--test)\b|npm\s+(?:test|run\s+(?:test|check|lint|typecheck|build|verify))\b)/i,
	/^\s*(?:cargo\s+(?:test|check|clippy)\b|dotnet\s+(?:test|build)\b|mvn\s+(?:test|compile)\b|pytest\b)/i,
];

const MUTATING_BASH_PATTERNS = [
	/(^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|tee)\b/i,
	/(^|[;&|]\s*)git\s+(?:add|commit|merge|rebase|reset|checkout|switch|push|pull|clean|restore|stash|apply)\b/i,
	/(^|[;&|]\s*)(?:npm|pnpm|yarn)\s+(?:install|add|update|remove|uninstall|upgrade)\b/i,
	/(^|[;&|]\s*)cargo\s+update\b/i,
	/(^|[;&|]\s*)(?:sed\s+-i|perl\s+-pi)\b/i,
	/(^|[^2])>\s*(?!\/dev\/null\b)/,
	/>>\s*(?!\/dev\/null\b)/,
];

const SOURCE_MUTATING_BASH_PATTERNS = [
	/(^|[;&|]\s*)(?:tee)\b/i,
	/(^|[;&|]\s*)(?:sed\s+-i|perl\s+-pi)\b/i,
	/(^|[^2])>\s*(?!\/dev\/null\b)/,
	/>>\s*(?!\/dev\/null\b)/,
];

const COMMIT_BASH_PATTERNS = [
	/(^|[;&|]\s*)git\s+(?:commit|push)\b/i,
];

const WorkflowDecisionParams = {
	type: "object",
	properties: {
		mode: {
			anyOf: [{ const: "direct", type: "string" }, { const: "subagent", type: "string" }],
			description:
				"Use 'subagent' for substantial work unless the user explicitly asked for direct/no-subagent execution.",
		},
		taskSize: {
			anyOf: [{ const: "small", type: "string" }, { const: "substantial", type: "string" }],
			description:
				"Classify the user request. Substantial means multi-file, risky, architectural, feature, bugfix, refactor, or long-horizon work.",
		},
		skills: {
			type: "array",
			items: { type: "string" },
			description:
				"Skills you have invoked or are applying, e.g. using-superpowers, frontend-design, subagent-driven-development, test-driven-development.",
		},
		reason: {
			type: "string",
			description: "Short explanation of why this workflow mode is appropriate.",
		},
	},
	required: ["mode", "taskSize", "skills", "reason"],
	additionalProperties: false,
} as const as TSchema;

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function startsWithSlashCommand(prompt: string): boolean {
	return prompt.trimStart().startsWith("/");
}

function hasExplicitDirectRequest(text: string): boolean {
	return /\b(?:ohne\s+subagents?|no\s+subagents?|without\s+subagents?|mach\s+direkt|do\s+directly|direkt\s+machen|small\/direct|direct\s+mode)\b/i.test(text);
}

function isDelegatedSubagentPrompt(text: string): boolean {
	return /\bdelegated\s+subagent\s+running\s+from\s+a\s+fork\s+of\s+the\s+parent\s+session\b/i.test(text);
}

function hasSingleFileArtifactRequest(text: string): boolean {
	return /\b(?:single[-\s]?file|one[-\s]?file|in\s+(?:a\s+)?single\s+file|single\s+html\s+file|one\s+html\s+file|eine\s+(?:einzelne\s+)?(?:datei|html[-\s]?datei)|nur\s+eine\s+datei)\b/i.test(
		text,
	);
}

function hasSubstantialArtifactMarker(text: string): boolean {
	return /\b(?:app|application|browser\s+game|dashboard|frontend|game|interactive|playable|polished|site|spiel|tool|ui|website|web\s+app)\b/i.test(
		text,
	);
}

function hasSmallTaskMarker(text: string): boolean {
	return /\b(?:typo|tippfehler|one[-\s]?line|einzeil|klein(?:e|er|es)?|tiny|quick|kurz|nur\s+(?:eine|1)\s+(?:zeile|line))\b/i.test(text);
}

export function classifyPromptForWorkflow(prompt: string): WorkflowPromptClassification {
	const text = normalizeText(prompt);
	if (isDelegatedSubagentPrompt(prompt)) {
		return {
			taskSize: "small",
			explicitDirect: true,
			reason: "delegated subagent execution prompt",
		};
	}

	const singleFileArtifact = hasSingleFileArtifactRequest(prompt);
	const explicitDirect = hasExplicitDirectRequest(prompt);
	const smallMarker = hasSmallTaskMarker(prompt);
	const substantialArtifact = singleFileArtifact && hasSubstantialArtifactMarker(prompt);
	const substantialMarker =
		substantialArtifact ||
		/\b(?:implement|implementiere|build|baue|feature|bugfix|fix|refactor|refaktor|rewrite|migration|upgrade|workflow|harness|extension|architecture|architektur|tests?|tdd|review|substantial|umfangreich|größer|komplex|multi[-\s]?file|mehrere\s+dateien)\b/i.test(
			prompt,
		);
	const longPrompt = text.length > 180;

	if (!explicitDirect && !smallMarker && (substantialMarker || longPrompt)) {
		return {
			taskSize: "substantial",
			explicitDirect,
			reason: substantialMarker ? "prompt contains substantial-work markers" : "prompt is long enough to warrant workflow discipline",
		};
	}

	return {
		taskSize: "small",
		explicitDirect,
		reason: explicitDirect ? "user explicitly requested direct execution" : "prompt appears small",
	};
}

export function createWorkflowGuardStateForPrompt(prompt: string): WorkflowGuardState {
	const classification = classifyPromptForWorkflow(prompt);
	const decision =
		classification.taskSize === "substantial" && !classification.explicitDirect
			? {
					mode: "subagent" as const,
					taskSize: "substantial" as const,
					skills: ["using-superpowers", "subagent-driven-development"],
					reason: "Harness selected subagent workflow for substantial work.",
				}
			: undefined;

	return {
		classification,
		decision,
		subagentStarted: false,
		todoCreateCount: 0,
		todoPhases: {},
	};
}

function isReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
	return READ_ONLY_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function isMutatingToolCall(call: ToolCallSummary): boolean {
	if (call.toolName === "edit" || call.toolName === "write" || call.toolName === "append") return true;
	if (call.toolName !== "bash") return false;
	const command = typeof call.input.command === "string" ? call.input.command : "";
	return !isReadOnlyBash(command) && MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function isSourceMutationCall(call: ToolCallSummary): boolean {
	if (call.toolName === "edit" || call.toolName === "write" || call.toolName === "append") return true;
	if (call.toolName !== "bash") return false;
	const command = typeof call.input.command === "string" ? call.input.command : "";
	return SOURCE_MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function isCommitCall(call: ToolCallSummary): boolean {
	if (call.toolName !== "bash") return false;
	const command = typeof call.input.command === "string" ? call.input.command : "";
	return COMMIT_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function hasExecutionSkill(skills: string[]): boolean {
	return skills.some((skill) => EXECUTION_SKILLS.has(skill));
}

export function validateWorkflowDecision(decision: WorkflowDecision): string[] {
	const errors: string[] = [];
	if (decision.taskSize === "substantial") {
		if (!decision.skills.includes("using-superpowers")) {
			errors.push("Substantial tasks must declare using-superpowers in skills.");
		}
		if (!hasExecutionSkill(decision.skills)) {
			errors.push("Substantial tasks must declare at least one execution skill.");
		}
	}
	if (decision.mode === "subagent" && decision.taskSize !== "substantial") {
		errors.push("Subagent mode should be reserved for substantial tasks.");
	}
	if (decision.reason.trim().length < 8) {
		errors.push("Workflow decision reason is too short.");
	}
	return errors;
}

export function evaluateMutationGate(state: WorkflowGuardState, call: ToolCallSummary): MutationGateResult {
	if (!isMutatingToolCall(call)) return { block: false };

	if (!state.decision) {
		if (state.classification.taskSize === "small") {
			return { block: false };
		}
		return {
			block: true,
			reason:
				"Workflow guard blocked mutation: call workflow_decision before edit/write/append or mutating bash. For substantial work, declare relevant skills and use subagent mode first.",
		};
	}

	const validationErrors = validateWorkflowDecision(state.decision);
	if (validationErrors.length > 0) {
		return {
			block: true,
			reason: `Workflow guard blocked mutation: ${validationErrors.join(" ")}`,
		};
	}

	const substantial = state.classification.taskSize === "substantial" || state.decision.taskSize === "substantial";
	if (substantial && !state.classification.explicitDirect && state.decision.mode !== "subagent") {
		return {
			block: true,
			reason:
				"Workflow guard blocked mutation: substantial tasks require subagent mode unless the user explicitly asked for direct/no-subagent execution.",
		};
	}

	if (state.decision.mode === "subagent" && !state.subagentStarted) {
		return {
			block: true,
			reason:
				"Workflow guard blocked mutation: workflow_decision selected subagent mode. Run a subagent execution before mutating files.",
		};
	}

	return { block: false };
}

export function isSubagentExecution(call: ToolCallSummary): boolean {
	if (!SUBAGENT_TOOL_NAMES.has(call.toolName)) return false;
	const action = typeof call.input.action === "string" ? call.input.action : "";
	if (["list", "get", "status", "doctor", "interrupt", "resume"].includes(action)) return false;
	return Boolean(call.input.agent || call.input.tasks || call.input.chain || call.input.chainName);
}

function getTodoPhase(value: unknown): WorkflowTodoPhase | undefined {
	if (typeof value !== "string") return undefined;
	return REQUIRED_TODO_PHASES.includes(value as WorkflowTodoPhase) ? (value as WorkflowTodoPhase) : undefined;
}

function getMetadataPhase(metadata: unknown): WorkflowTodoPhase | undefined {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
	return getTodoPhase((metadata as JsonRecord).phase);
}

export function isTodoCreateCall(call: ToolCallSummary): boolean {
	if (!TODO_TOOL_NAMES.has(call.toolName)) return false;
	if (call.input.action !== "create") return false;
	return (
		typeof call.input.subject === "string" &&
		call.input.subject.trim().length > 0 &&
		typeof call.input.description === "string" &&
		call.input.description.trim().length >= 20 &&
		typeof call.input.activeForm === "string" &&
		call.input.activeForm.trim().length > 0 &&
		getMetadataPhase(call.input.metadata) !== undefined
	);
}

type TodoTaskSnapshot = {
	status?: unknown;
	metadata?: unknown;
	description?: unknown;
	activeForm?: unknown;
};

function isValidPhaseTodo(task: TodoTaskSnapshot): task is TodoTaskSnapshot & { status: WorkflowTodoStatus } {
	const phase = getMetadataPhase(task.metadata);
	if (!phase) return false;
	if (!["pending", "in_progress", "completed", "deleted"].includes(String(task.status))) return false;
	if (typeof task.description !== "string" || task.description.trim().length < 20) return false;
	if (typeof task.activeForm !== "string" || task.activeForm.trim().length === 0) return false;
	return true;
}

export function syncTodoStateFromDetails(state: WorkflowGuardState, details: unknown): void {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return;
	const tasks = (details as JsonRecord).tasks;
	if (!Array.isArray(tasks)) return;

	const phases: Partial<Record<WorkflowTodoPhase, WorkflowTodoStatus>> = {};
	let count = 0;
	for (const task of tasks) {
		if (typeof task !== "object" || task === null || Array.isArray(task)) continue;
		const candidate = task as TodoTaskSnapshot;
		if (!isValidPhaseTodo(candidate)) continue;
		const phase = getMetadataPhase(candidate.metadata);
		if (!phase || candidate.status === "deleted") continue;
		count += 1;
		phases[phase] = candidate.status;
	}
	state.todoCreateCount = count;
	state.todoPhases = phases;
}

function requiresSubstantialTodos(state: WorkflowGuardState): boolean {
	return state.classification.taskSize === "substantial" && !state.classification.explicitDirect;
}

function missingTodoPhases(state: WorkflowGuardState): WorkflowTodoPhase[] {
	const phases = state.todoPhases ?? {};
	return REQUIRED_TODO_PHASES.filter((phase) => !phases[phase]);
}

function evaluateTodoGate(state: WorkflowGuardState): MutationGateResult {
	if (!requiresSubstantialTodos(state)) return { block: false };
	const missing = missingTodoPhases(state);
	if (missing.length === 0) return { block: false };
	return {
		block: true,
		reason: `Workflow guard blocked action: create described todo items with metadata.phase for: ${missing.join(", ")}.`,
	};
}

function evaluateTodoCreateGate(state: WorkflowGuardState, call: ToolCallSummary): MutationGateResult {
	if (!requiresSubstantialTodos(state) || !TODO_TOOL_NAMES.has(call.toolName) || call.input.action !== "create") {
		return { block: false };
	}
	if (isTodoCreateCall(call)) return { block: false };
	return {
		block: true,
		reason:
			"Workflow guard blocked todo create: substantial work todos must include subject, description, activeForm, and metadata.phase using one of: investigate, plan, execute, review, verify.",
	};
}

function evaluateExecutionPhaseGate(state: WorkflowGuardState, call: ToolCallSummary): MutationGateResult {
	if (!requiresSubstantialTodos(state) || !isSourceMutationCall(call)) return { block: false };
	if (state.todoPhases?.execute === "in_progress") return { block: false };
	return {
		block: true,
		reason: "Workflow guard blocked source mutation: set the execute todo to in_progress before editing files.",
	};
}

function evaluateCompletionPhaseGate(state: WorkflowGuardState, call: ToolCallSummary): MutationGateResult {
	if (!requiresSubstantialTodos(state) || !isCommitCall(call)) return { block: false };
	if (state.todoPhases?.review === "completed" && state.todoPhases?.verify === "completed") return { block: false };
	return {
		block: true,
		reason: "Workflow guard blocked commit/push: complete review and verify todos before committing or pushing.",
	};
}

export function evaluateToolCallGate(state: WorkflowGuardState, call: ToolCallSummary): MutationGateResult {
	if (call.toolName === WORKFLOW_DECISION_TOOL) return { block: false };
	const todoCreateGate = evaluateTodoCreateGate(state, call);
	if (todoCreateGate.block) return todoCreateGate;
	if (TODO_TOOL_NAMES.has(call.toolName)) return { block: false };
	if (isSubagentExecution(call)) return evaluateTodoGate(state);
	const todoGate = evaluateTodoGate(state);
	if (todoGate.block && isMutatingToolCall(call)) return todoGate;
	const executionGate = evaluateExecutionPhaseGate(state, call);
	if (executionGate.block) return executionGate;
	const completionGate = evaluateCompletionPhaseGate(state, call);
	if (completionGate.block) return completionGate;
	return evaluateMutationGate(state, call);
}

export function findSkillLocation(systemPrompt: string, skillName: string): string | undefined {
	const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`<name>\\s*${escaped}\\s*<\\/name>[\\s\\S]*?<location>([^<]+)<\\/location>`, "i");
	const match = systemPrompt.match(pattern);
	return match?.[1]?.trim();
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	return content.slice(end + 4).trimStart();
}

function buildSkillBlock(systemPrompt: string, skillName: string): string | undefined {
	const location = findSkillLocation(systemPrompt, skillName);
	if (!location) return undefined;
	try {
		const content = stripFrontmatter(readFileSync(location, "utf-8")).trim();
		return `<skill name="${skillName}" location="${location}">\nReferences are relative to ${location.replace(/\/SKILL\.md$/, "")}.\n\n${content}\n</skill>`;
	} catch {
		return undefined;
	}
}

function buildWorkflowSystemPrompt(systemPrompt: string, prompt: string): string {
	if (startsWithSlashCommand(prompt)) return systemPrompt;
	const usingSuperpowers = buildSkillBlock(systemPrompt, "using-superpowers");
	const todoTool = buildSkillBlock(systemPrompt, "todo-tool");
	const guardInstructions = [
		"Workflow guard is active.",
		"For small/direct tasks, proceed directly; workflow_decision is optional.",
		"For substantial work, the harness preselects subagent mode unless the user explicitly asked for direct/no-subagent execution.",
		"For substantial work, create described todo items with activeForm and metadata.phase for investigate, plan, execute, review, and verify before subagent execution or source mutations.",
		"Before source mutations on substantial work, update the execute todo to in_progress.",
		"Before git commit or push on substantial work, complete the review and verify todos.",
		"For substantial work, run a subagent before the first mutation.",
		"Use workflow_decision only to explicitly declare or adjust workflow mode before mutations.",
		"Use direct mode only for small tasks or explicit direct/no-subagent user requests.",
	].join("\n");
	return [
		systemPrompt,
		"",
		"<workflow_guard>",
		guardInstructions,
		usingSuperpowers ? `\n${usingSuperpowers}` : "",
		todoTool ? `\n${todoTool}` : "",
		"</workflow_guard>",
	].join("\n");
}

function normalizeDecision(params: {
	mode: "direct" | "subagent";
	taskSize: "small" | "substantial";
	skills: string[];
	reason: string;
}): WorkflowDecision {
	return {
		mode: params.mode,
		taskSize: params.taskSize,
		skills: params.skills.map((skill) => skill.trim()).filter(Boolean),
		reason: params.reason.trim(),
	};
}

export default function workflowGuard(pi: ExtensionAPI) {
	const state: WorkflowGuardState = {
		classification: classifyPromptForWorkflow(""),
		subagentStarted: false,
		todoCreateCount: 0,
		todoPhases: {},
	};

	pi.registerTool({
		name: WORKFLOW_DECISION_TOOL,
		label: "Workflow Decision",
		description:
			"Declare the workflow before source mutations. Use subagent mode for substantial tasks unless the user explicitly requested direct/no-subagent execution.",
		promptSnippet: "Declare direct vs subagent workflow before mutating files.",
		promptGuidelines: [
			"For substantial work, the harness already preselects subagent mode unless the user explicitly requested direct/no-subagent execution.",
			"Declare using-superpowers plus at least one execution skill; frontend-design is valid for frontend/artifact/game work.",
			"Before subagent execution or source mutations, create todo items with metadata.phase: investigate, plan, execute, review, verify.",
			"Set the execute todo to in_progress before source mutations; complete review and verify todos before git commit or push.",
		],
		parameters: WorkflowDecisionParams,
		async execute(_toolCallId, params) {
			const decision = normalizeDecision(params);
			const errors = validateWorkflowDecision(decision);
			if (errors.length > 0) {
				return {
					content: [{ type: "text", text: `Workflow decision rejected:\n- ${errors.join("\n- ")}` }],
					isError: true,
					details: { decision, errors },
				};
			}
			state.decision = decision;
			return {
				content: [
					{
						type: "text",
						text: `Workflow decision accepted: ${decision.mode} (${decision.taskSize}).`,
					},
				],
				details: { decision },
			};
		},
	});

	pi.on("before_agent_start", (event) => {
		const nextState = createWorkflowGuardStateForPrompt(event.prompt);
		state.classification = nextState.classification;
		state.decision = nextState.decision;
		state.subagentStarted = nextState.subagentStarted;
		state.todoCreateCount = nextState.todoCreateCount;
		state.todoPhases = nextState.todoPhases;
		return { systemPrompt: buildWorkflowSystemPrompt(event.systemPrompt, event.prompt) };
	});

	pi.on("tool_call", (event) => {
		const call = { toolName: event.toolName, input: event.input as JsonRecord };
		const gate = evaluateToolCallGate(state, call);
		if (!gate.block) return;
		return { block: true, reason: gate.reason };
	});

	pi.on("tool_result", (event) => {
		const call = { toolName: event.toolName, input: event.input as JsonRecord };
		if (!event.isError && TODO_TOOL_NAMES.has(event.toolName)) {
			syncTodoStateFromDetails(state, event.details);
		} else if (!event.isError && isTodoCreateCall(call)) {
			state.todoCreateCount += 1;
		}
		if (!event.isError && isSubagentExecution(call)) {
			state.subagentStarted = true;
		}
	});
}
