import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

type JsonRecord = Record<string, unknown>;

export type WorkflowMode = "direct" | "subagent";
export type WorkflowTaskSize = "small" | "substantial";

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
const EXECUTION_SKILLS = new Set([
	"brainstorming",
	"dispatching-parallel-agents",
	"executing-plans",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
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
				"Skills you have invoked or are applying, e.g. using-superpowers, brainstorming, subagent-driven-development, test-driven-development.",
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
	const guardInstructions = [
		"Workflow guard is active.",
		"For small/direct tasks, proceed directly; workflow_decision is optional.",
		"For substantial work, the harness preselects subagent mode unless the user explicitly asked for direct/no-subagent execution.",
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
	};

	pi.registerTool({
		name: WORKFLOW_DECISION_TOOL,
		label: "Workflow Decision",
		description:
			"Declare the workflow before source mutations. Use subagent mode for substantial tasks unless the user explicitly requested direct/no-subagent execution.",
		promptSnippet: "Declare direct vs subagent workflow before mutating files.",
		promptGuidelines: [
			"Call workflow_decision before edit/write/append or mutating bash for substantial work.",
			"For substantial work, list using-superpowers and a relevant execution skill, then run a subagent before mutating files.",
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
		return { systemPrompt: buildWorkflowSystemPrompt(event.systemPrompt, event.prompt) };
	});

	pi.on("tool_call", (event) => {
		const call = { toolName: event.toolName, input: event.input as JsonRecord };
		if (event.toolName === WORKFLOW_DECISION_TOOL) return;
		if (isSubagentExecution(call)) return;
		const gate = evaluateMutationGate(state, call);
		if (!gate.block) return;
		return { block: true, reason: gate.reason };
	});

	pi.on("tool_result", (event) => {
		const call = { toolName: event.toolName, input: event.input as JsonRecord };
		if (!event.isError && isSubagentExecution(call)) {
			state.subagentStarted = true;
		}
	});
}
