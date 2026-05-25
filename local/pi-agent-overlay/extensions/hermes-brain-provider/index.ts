import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const PRIMARY = {
	name: "Hermes Brain",
	provider: "hermes-brain",
	model: "hermes-brain",
	baseUrl: "http://127.0.0.1:8081/v1",
	fallbackContext: 200000,
	maxTokens: 32768,
};

const APPROVAL = {
	name: "Hermes Approval",
	provider: "hermes-approval",
	model: "approval",
	baseUrl: "http://127.0.0.1:8091/v1",
	fallbackContext: 4096,
	maxTokens: 32,
};

const APPROVAL_PROFILE = "project-dev";

type JsonRecord = Record<string, unknown>;

export type GitFileState = {
	insideWorkTree: boolean;
	tracked: boolean;
	clean: boolean;
	status?: string;
};

export type PreflightAction = "allow" | "sidecar" | "ask" | "deny";

export type PreflightDecision = {
	action: PreflightAction;
	reason: string;
	approvalPrompt?: string;
	mutation?: boolean;
	targetPaths?: string[];
};

export type MutationDenialMemory = {
	record: (paths: string[], reason: string) => void;
	clear: (paths: string[]) => void;
	check: (paths: string[]) => { path: string; reason: string; timestamp: number } | undefined;
};

export type TrustedProjectMemory = {
	grant: (root: string) => void;
	isTrusted: (root: string) => boolean;
	roots: () => string[];
};

export type TrustedCommandMemory = {
	grant: (root: string, command: string) => void;
	isTrusted: (root: string, command: string) => boolean;
	commands: (root: string) => string[];
};

export type TrustedToolMemory = {
	grant: (toolName: string) => void;
	isTrusted: (toolName: string) => boolean;
	tools: () => string[];
};

export type ApprovalLogEntry = {
	timestamp: number;
	cwd: string;
	toolName: string;
	action: PreflightAction;
	reason: string;
};

export type ApprovalDecisionLog = {
	record: (entry: Omit<ApprovalLogEntry, "timestamp">) => void;
	entries: () => ApprovalLogEntry[];
};

export type ToolPreflightInput = {
	toolName: string;
	input: JsonRecord;
	cwd: string;
};

type PolicyDeps = {
	readFile: (path: string) => Promise<string | undefined>;
	pathExists: (path: string) => Promise<boolean>;
	gitState: (cwd: string, path: string) => Promise<GitFileState>;
};

type EditInput = {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
};

type MutationSummary = {
	path: string;
	editCount: number;
	addedLines: number;
	removedLines: number;
	addedChars: number;
	removedChars: number;
	touchesWholeExistingFile: boolean;
	emptiesExistingFile: boolean;
	isHuge: boolean;
	isSmall: boolean;
	reason: string;
	excerpt: string;
};

const READ_ONLY_TOOL_NAMES = new Set([
	"cat",
	"find",
	"glob",
	"grep",
	"inspect",
	"list",
	"list_dir",
	"ls",
	"read",
	"read_file",
	"rg",
	"search",
	"search_files",
	"view",
]);

const SAFE_AGENT_META_TOOL_NAMES = new Set([
	"notes",
	"plan",
	"task",
	"tasks",
	"todo",
	"todos",
	"update_plan",
]);

const CORE_MUTATING_TOOL_NAMES = new Set(["bash", "edit", "write"]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function getPath(root: unknown, path: string[]): unknown {
	let cursor = root;
	for (const segment of path) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

function truncate(value: string, limit = 1200): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function lineCount(value: string): number {
	if (value.length === 0) return 0;
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n").length;
}

function resolveTarget(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function isReadOnlyToolName(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	if (READ_ONLY_TOOL_NAMES.has(normalized)) return true;
	return /^(read|list|search|find|grep|rg|glob|view|inspect)(_|$)/.test(normalized);
}

function normalizeToolName(toolName: string): string {
	return toolName.toLowerCase().replace(/-/g, "_");
}

function isSafeAgentMetaToolName(toolName: string): boolean {
	return SAFE_AGENT_META_TOOL_NAMES.has(normalizeToolName(toolName));
}

function uniquePaths(paths: Array<string | undefined>): string[] {
	return Array.from(new Set(paths.filter((path): path is string => typeof path === "string" && path.length > 0)));
}

function isPathInsideRoot(path: string, root: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedPath = resolve(path);
	const relPath = relative(normalizedRoot, normalizedPath);
	return relPath === "" || (relPath.length > 0 && !relPath.startsWith("..") && !isAbsolute(relPath));
}

function isSensitivePath(path: string): boolean {
	const parts = resolve(path).split(/[\\/]+/);
	return parts.some((part) =>
		part === ".ssh" ||
		part === ".gnupg" ||
		part === ".password-store" ||
		/^\.env(?:\.|$)/i.test(part) ||
		/^id_(?:rsa|ed25519|ecdsa)$/i.test(part) ||
		/\.(?:pem|p12|pfx|key)$/i.test(part)
	);
}

function mutationDecision(decision: PreflightDecision, targetPaths: string[]): PreflightDecision {
	return { ...decision, mutation: true, targetPaths: uniquePaths(targetPaths) };
}

function normalizeTrustedCommand(command: string): string {
	return stripHarmlessShellNoise(command).trim();
}

export function createTrustedProjectMemory(): TrustedProjectMemory {
	const roots = new Set<string>();

	return {
		grant(root: string) {
			roots.add(resolve(root));
		},
		isTrusted(root: string) {
			const normalizedRoot = resolve(root);
			for (const trustedRoot of roots) {
				if (isPathInsideRoot(normalizedRoot, trustedRoot)) return true;
			}
			return false;
		},
		roots() {
			return Array.from(roots);
		},
	};
}

export function createTrustedCommandMemory(): TrustedCommandMemory {
	const commandsByRoot = new Map<string, Set<string>>();

	return {
		grant(root: string, command: string) {
			const normalizedRoot = resolve(root);
			const normalizedCommand = normalizeTrustedCommand(command);
			if (!normalizedCommand) return;
			const commands = commandsByRoot.get(normalizedRoot) ?? new Set<string>();
			commands.add(normalizedCommand);
			commandsByRoot.set(normalizedRoot, commands);
		},
		isTrusted(root: string, command: string) {
			const normalizedRoot = resolve(root);
			const normalizedCommand = normalizeTrustedCommand(command);
			for (const [trustedRoot, commands] of commandsByRoot) {
				if (isPathInsideRoot(normalizedRoot, trustedRoot) && commands.has(normalizedCommand)) return true;
			}
			return false;
		},
		commands(root: string) {
			const normalizedRoot = resolve(root);
			const commands = new Set<string>();
			for (const [trustedRoot, trustedCommands] of commandsByRoot) {
				if (!isPathInsideRoot(normalizedRoot, trustedRoot)) continue;
				for (const command of trustedCommands) commands.add(command);
			}
			return Array.from(commands);
		},
	};
}

export function createTrustedToolMemory(): TrustedToolMemory {
	const tools = new Set<string>();

	return {
		grant(toolName: string) {
			const normalized = normalizeToolName(toolName);
			if (CORE_MUTATING_TOOL_NAMES.has(normalized)) return;
			if (isReadOnlyToolName(normalized) || isSafeAgentMetaToolName(normalized)) return;
			tools.add(normalized);
		},
		isTrusted(toolName: string) {
			return tools.has(normalizeToolName(toolName));
		},
		tools() {
			return Array.from(tools);
		},
	};
}

export function createMutationDenialMemory(): MutationDenialMemory {
	const denied = new Map<string, { reason: string; timestamp: number }>();

	return {
		record(paths: string[], reason: string) {
			const timestamp = Date.now();
			for (const path of uniquePaths(paths)) denied.set(path, { reason, timestamp });
		},
		clear(paths: string[]) {
			for (const path of uniquePaths(paths)) denied.delete(path);
		},
		check(paths: string[]) {
			for (const path of uniquePaths(paths)) {
				const denial = denied.get(path);
				if (denial) return { path, ...denial };
			}
			return undefined;
		},
	};
}

export function createApprovalDecisionLog(limit = 50): ApprovalDecisionLog {
	const entries: ApprovalLogEntry[] = [];

	return {
		record(entry: Omit<ApprovalLogEntry, "timestamp">) {
			entries.push({ ...entry, timestamp: Date.now() });
			while (entries.length > limit) entries.shift();
		},
		entries() {
			return [...entries];
		},
	};
}

export function applyMutationDenialMemory(
	preflight: PreflightDecision,
	memory: MutationDenialMemory,
): PreflightDecision {
	if (!preflight.mutation || !preflight.targetPaths?.length) return preflight;
	const denial = memory.check(preflight.targetPaths);
	if (!denial) return preflight;
	return {
		...preflight,
		action: "ask",
		reason: `previous user denial for ${denial.path}; ask the user for clarification before trying another mutation path`,
		approvalPrompt: [preflight.approvalPrompt, `previous_user_denial=${denial.reason}`].filter(Boolean).join("\n"),
	};
}

async function fetchJson(url: string, timeoutMs = 800): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function extractContext(payload: unknown, modelId?: string): number | undefined {
	const directPaths = [
		["default_generation_settings", "n_ctx"],
		["default_generation_settings", "n_ctx_slot"],
		["default_generation_settings", "n_ctx_train"],
		["model_meta", "qwen3.context_length"],
		["model_meta", "qwen2.context_length"],
		["model_meta", "llama.context_length"],
		["model_meta", "general.context_length"],
		["model_meta", "n_ctx_train"],
		["n_ctx"],
		["n_ctx_slot"],
		["n_ctx_train"],
		["context_length"],
		["contextWindow"],
		["context_window"],
	];

	for (const path of directPaths) {
		const value = asNumber(getPath(payload, path));
		if (value) return Math.floor(value);
	}

	if (Array.isArray(payload)) {
		for (const item of payload) {
			const value = extractContext(item, modelId);
			if (value) return value;
		}
	}

	if (isRecord(payload)) {
		for (const key of ["slots", "data", "models"]) {
			const nested = payload[key];
			if (!Array.isArray(nested)) continue;
			const candidates = modelId
				? nested.filter((item) => isRecord(item) && (item.id === modelId || item.model === modelId))
				: nested;
			for (const item of candidates.length > 0 ? candidates : nested) {
				const value = extractContext(item, modelId);
				if (value) return value;
			}
		}
	}

	return undefined;
}

async function detectContext(baseUrl: string, modelId: string, fallback: number): Promise<number> {
	const rootUrl = baseUrl.replace(/\/v1\/?$/, "");
	for (const url of [`${rootUrl}/props`, `${rootUrl}/slots`, `${baseUrl}/models`]) {
		const detected = extractContext(await fetchJson(url), modelId);
		if (detected) return detected;
	}
	return fallback;
}

function modelDefinition(profile: typeof PRIMARY | typeof APPROVAL, contextWindow: number) {
	const isPrimary = profile.provider === PRIMARY.provider;
	return {
		id: profile.model,
		name: profile.name,
		reasoning: isPrimary,
		thinkingLevelMap: isPrimary
			? {
					minimal: "on",
					low: "on",
					medium: "on",
					high: "on",
					xhigh: "on",
				}
			: undefined,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: profile.maxTokens,
		compat: isPrimary
			? {
					thinkingFormat: "qwen-chat-template",
				}
			: undefined,
	};
}

function registerHermesProvider(pi: ExtensionAPI, profile: typeof PRIMARY | typeof APPROVAL, contextWindow: number) {
	pi.registerProvider(profile.provider, {
		name: profile.name,
		baseUrl: profile.baseUrl,
		apiKey: "local",
		api: "openai-completions",
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			maxTokensField: "max_tokens",
			requiresToolResultName: true,
			supportsStrictMode: false,
			thinkingFormat: profile.provider === PRIMARY.provider ? "qwen-chat-template" : undefined,
		},
		models: [modelDefinition(profile, contextWindow)],
	});
}

function stripHarmlessShellNoise(command: string): string {
	return command
		.replace(/\s+\d?>\s*\/dev\/null\b/g, "")
		.replace(/\s+>\s*\/dev\/null\b/g, "")
		.replace(/\s+\d?>&\d+\b/g, "");
}

function stripReadOnlyWrappers(command: string): string {
	let trimmed = command.trim();
	for (let i = 0; i < 3; i++) {
		const timeout = trimmed.match(/^timeout\s+(?:--foreground\s+|--preserve-status\s+|-k\s+\S+\s+)*(?:\d+(?:\.\d+)?[smhd]?)\s+(.+)$/i);
		if (!timeout) break;
		trimmed = timeout[1].trim();
	}
	return trimmed;
}

function findCommandSubstitutionEnd(command: string, start: number): number | undefined {
	let depth = 1;
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = start; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			continue;
		}
		if (char === "\"" && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			continue;
		}
		if (singleQuoted) continue;

		if (char === "$" && next === "(") {
			depth++;
			i++;
			continue;
		}
		if (char === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}

	return undefined;
}

function findShellGroupEnd(command: string, start: number): number | undefined {
	let depth = 1;
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = start; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			continue;
		}
		if (char === "\"" && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			continue;
		}
		if (singleQuoted) continue;

		if (!doubleQuoted && char === "(") {
			depth++;
			continue;
		}
		if (!doubleQuoted && char === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}

	return undefined;
}

function normalizeReadOnlyCommandSubstitutions(command: string, substitutionDepth: number): string | undefined {
	if (substitutionDepth > 4) return undefined;
	let result = "";
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			result += char;
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			result += char;
			continue;
		}
		if (char === "\"" && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			result += char;
			continue;
		}
		if (!singleQuoted && char === "$" && next === "(") {
			const end = findCommandSubstitutionEnd(command, i + 2);
			if (end === undefined) return undefined;
			const inner = command.slice(i + 2, end);
			if (!inner.trim() || !isObviouslyReadOnly(inner, substitutionDepth + 1)) return undefined;
			result += "__pi_readonly_substitution__";
			i = end;
			continue;
		}

		result += char;
	}

	return result;
}

function normalizeReadOnlyShellGroups(command: string, substitutionDepth: number): string | undefined {
	if (substitutionDepth > 4) return undefined;
	let result = "";
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			result += char;
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			result += char;
			continue;
		}
		if (char === "\"" && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			result += char;
			continue;
		}
		if (!singleQuoted && !doubleQuoted && char === "(") {
			const end = findShellGroupEnd(command, i + 1);
			if (end === undefined) return undefined;
			const inner = command.slice(i + 1, end);
			if (!inner.trim() || !isObviouslyReadOnly(inner, substitutionDepth + 1)) return undefined;
			result += "__pi_readonly_group__";
			i = end;
			continue;
		}

		result += char;
	}

	return result;
}

function hasUnsafeShellControlSyntax(command: string): boolean {
	const normalized = stripHarmlessShellNoise(command);
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = 0; i < normalized.length; i++) {
		const char = normalized[i];
		const next = normalized[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			continue;
		}
		if (char === "\"" && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			continue;
		}
		if (singleQuoted) continue;

		if (char === "<" || char === ">" || char === "`" || char === "$") return true;
		if (!doubleQuoted && (char === "(" || char === ")")) return true;
		if (!doubleQuoted && char === "&" && next !== "&" && normalized[i - 1] !== "&") return true;
	}

	return singleQuoted || doubleQuoted || escaped;
}

function splitShellSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let current = "";
	let singleQuoted = false;
	let doubleQuoted = false;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && !singleQuoted) {
			current += char;
			escaped = true;
			continue;
		}
		if (char === "'" && !doubleQuoted) {
			singleQuoted = !singleQuoted;
			current += char;
			continue;
		}
		if (char === "\"" && !singleQuoted) {
			doubleQuoted = !doubleQuoted;
			current += char;
			continue;
		}
		if (!singleQuoted && !doubleQuoted && (char === ";" || char === "|")) {
			segments.push(current.trim());
			current = "";
			if (next === char) i++;
			continue;
		}
		if (!singleQuoted && !doubleQuoted && char === "&" && next === "&") {
			segments.push(current.trim());
			current = "";
			i++;
			continue;
		}
		current += char;
	}

	if (singleQuoted || doubleQuoted || escaped) return undefined;
	segments.push(current.trim());
	return segments;
}

function normalizedSingleCommand(command: string): string | undefined {
	const normalized = stripReadOnlyWrappers(stripHarmlessShellNoise(command).trim());
	if (!normalized || /[;&|<>`$()]/.test(normalized)) return undefined;
	return normalized;
}

function isReadOnlyShellSegment(segment: string): boolean {
	const trimmed = stripReadOnlyWrappers(segment).trim();
	if (!trimmed) return true;
	if (trimmed === "__pi_readonly_group__" || trimmed === "__pi_readonly_substitution__") return true;
	if (/^!\s+/.test(trimmed)) return isReadOnlyShellSegment(trimmed.replace(/^!\s+/, ""));
	if (/^(true|false)\s*$/i.test(trimmed)) return true;
	if (isLocalLoopbackCurlSegment(trimmed)) return true;
	if (isKnownDryRunOrInfoCommand(trimmed)) return true;
	if (isLocalArchiveMetadataCommand(trimmed)) return true;
	if (isLocalBinaryMetadataCommand(trimmed)) return true;
	if (isLocalPackageInfoCommand(trimmed)) return true;
	if (isSystemInspectionCommand(trimmed)) return true;
	if (/\b(rm|mv|cp|rsync|dd|chmod|chown|sudo|su|kill|pkill|systemctl|service|mount|umount|docker|podman|kubectl|git\s+(add|commit|checkout|switch|reset|clean|rebase|merge|pull|push|apply|am)|cargo\s+(fix|fmt|install)|npm\s+(install|add|update|upgrade|run)|pnpm\s+(install|add|update|upgrade|run)|yarn\s+(install|add|upgrade|run)|bun\s+(install|add|run)|pip3?\s+install|python3?\s+-m\s+pip\s+install|uv\s+(add|remove|sync|pip\s+install)|go\s+install)\b/i.test(trimmed)) {
		return false;
	}
	if (/^cd\s+(--\s+)?\S+\s*$/i.test(trimmed)) return true;
	if (/^find\b/i.test(trimmed)) return !/\s-(delete|exec|execdir|ok|okdir)\b/i.test(trimmed);
	if (/^npx\s+(--yes\s+)?skills\s+(find|search|list|info|show)\b/i.test(trimmed)) return true;
	if (/^(node|npm|pnpm|yarn|bun|python3?|pip3?|uv|cargo|rustc|go|java|javac|mvn|gradle|git)\s+(--version|-v|version)\b/i.test(trimmed)) return true;
	if (/^echo\b/i.test(trimmed)) return true;
	if (isReadOnlyGitCommand(trimmed)) return true;
	return /^(pwd|ls|rg|grep|sed\s+-n|cat|head|tail|wc|stat|file|du|tree|realpath|readlink|basename|dirname|env|printenv|whoami|id|date|uname|which|whereis|command\s+-v|type\s+-a|ps|pgrep|lsof|ss|df|free|jq|sort|uniq|cut|tr|nl)\b/i.test(trimmed);
}

function isReadOnlyGitCommand(command: string): boolean {
	const trimmed = stripReadOnlyWrappers(command).trim();
	if (!/^git\s+/i.test(trimmed)) return false;
	if (/\bgit\s+(add|commit|checkout|switch|reset|clean|rebase|merge|pull|push|apply|am|clone|fetch)\b/i.test(trimmed)) return false;
	if (/^git\s+branch(?:\s+(?:--show-current|--list|-a|-r|-v|-vv))?(?:\s+--[a-z-]+|\s+-[a-z]+)*\s*$/i.test(trimmed)) return true;
	return /^git\s+(status|diff|log|show|rev-parse|ls-files|grep|cat-file|ls-tree|rev-list|count-objects|verify-pack|for-each-ref|describe|remote\s+-v|config\s+(--get|--get-regexp|--list)|lfs\s+(ls-files|status))\b/i.test(trimmed);
}

function hasFlag(command: string, flag: string): boolean {
	return new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`, "i").test(command);
}

function isKnownDryRunOrInfoCommand(command: string): boolean {
	const trimmed = stripReadOnlyWrappers(command).trim();
	if (/^[\w./-]+\s+(--help|-h)\s*$/i.test(trimmed)) return true;
	if (/^[\w./-]+\s+help(?:\s+\S+)?\s*$/i.test(trimmed)) return true;
	if (/^(npm|pnpm|yarn|bun)\s+(install|add|update|upgrade)\b/i.test(trimmed) && hasFlag(trimmed, "--dry-run")) return true;
	if (/^uv\s+(sync|add|remove|pip\s+install)\b/i.test(trimmed) && hasFlag(trimmed, "--dry-run")) return true;
	if (/^(npm|pnpm|yarn|bun)\s+run\s+[^\s;&|<>`$()]+\b/i.test(trimmed) && hasFlag(trimmed, "--dry-run")) return true;
	if (/^node\s+scripts\/[^\s;&|<>`$()]+\.m?js\b/i.test(trimmed) && hasFlag(trimmed, "--dry-run")) return true;
	if (/^cargo\s+fmt\b/i.test(trimmed) && hasFlag(trimmed, "--check")) return true;
	return false;
}

function isLocalArchiveMetadataCommand(command: string): boolean {
	const trimmed = stripReadOnlyWrappers(command).trim();
	return (
		/^tar\s+(?:-[a-z]*t[a-z]*|--list)\b/i.test(trimmed) ||
		/^unzip\s+-[lv]\b/i.test(trimmed) ||
		/^zipinfo\b/i.test(trimmed)
	);
}

function isLocalBinaryMetadataCommand(command: string): boolean {
	const trimmed = stripReadOnlyWrappers(command).trim();
	return /^(readelf|objdump|nm|size|strings|hexdump|xxd)\b/i.test(trimmed);
}

function isLocalPackageInfoCommand(command: string): boolean {
	const trimmed = stripReadOnlyWrappers(command).trim();
	return (
		/^(npm|pnpm|yarn|bun)\s+(ls|list)\b/i.test(trimmed) ||
		/^npm\s+pkg\s+(get|list)\b/i.test(trimmed) ||
		/^cargo\s+metadata\b/i.test(trimmed) ||
		/^pip3?\s+(show|list|check|freeze)\b/i.test(trimmed) ||
		/^python3?\s+-m\s+pip\s+(show|list|check|freeze)\b/i.test(trimmed) ||
		/^uv\s+pip\s+(show|list|check|freeze)\b/i.test(trimmed)
	);
}

function isSystemInspectionCommand(command: string): boolean {
	const trimmed = stripReadOnlyWrappers(command).trim();
	return (
		/^journalctl\b/i.test(trimmed) ||
		/^dmesg\b/i.test(trimmed) ||
		/^(lsblk|lspci|lsusb)\b/i.test(trimmed) ||
		/^systemctl\s+(status|show|list-units|list-unit-files|is-active|is-enabled)\b/i.test(trimmed)
	);
}

function isLoopbackHttpUrl(urlText: string): boolean {
	try {
		const url = new URL(urlText);
		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.");
	} catch {
		return false;
	}
}

function urlsInCommand(command: string): string[] {
	return Array.from(command.matchAll(/\bhttps?:\/\/[^\s'"`|;&<>$()]+/gi), (match) => match[0]);
}

function writesCurlOutputToFile(command: string): boolean {
	if (/(^|\s)(?:-O|--remote-name|--create-dirs)(?=\s|$)/i.test(command)) return true;
	const output = command.match(/(?:^|\s)(?:-o|--output)\s+([^\s'"`|;&<>$()]+)/i);
	return Boolean(output && output[1] !== "-");
}

function isLocalLoopbackCurlSegment(segment: string): boolean {
	const trimmed = stripReadOnlyWrappers(segment).trim();
	if (!/^curl\b/i.test(trimmed)) return false;
	if (writesCurlOutputToFile(trimmed)) return false;
	if (/(^|\s)--unix-socket(?=\s|=|$)/i.test(trimmed)) return true;
	const urls = urlsInCommand(trimmed);
	return urls.length > 0 && urls.every(isLoopbackHttpUrl);
}

function isLocalLoopbackCurlCommand(command: string): boolean {
	const normalized = stripHarmlessShellNoise(command.trim());
	if (!normalized) return false;
	if (!/\bcurl\b/i.test(normalized)) return false;
	if (hasUnsafeShellControlSyntax(normalized)) return false;
	const segments = splitShellSegments(normalized);
	return Boolean(segments?.length) && segments.every((segment) =>
		segment.length > 0 && (isLocalLoopbackCurlSegment(segment) || isReadOnlyShellSegment(segment))
	);
}

function isObviouslyReadOnly(command: string, substitutionDepth = 0): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	const normalized = stripHarmlessShellNoise(trimmed);
	const withReadOnlySubstitutions = normalizeReadOnlyCommandSubstitutions(normalized, substitutionDepth);
	if (!withReadOnlySubstitutions) return false;
	const withReadOnlyGroups = normalizeReadOnlyShellGroups(withReadOnlySubstitutions, substitutionDepth);
	if (!withReadOnlyGroups) return false;
	if (hasUnsafeShellControlSyntax(withReadOnlyGroups)) return false;
	const segments = splitShellSegments(withReadOnlyGroups);
	return Boolean(segments?.length) && segments.every((segment) => segment.length > 0 && isReadOnlyShellSegment(segment));
}

function isSkillsCliInstall(command: string): boolean {
	const normalized = normalizedSingleCommand(command);
	return Boolean(normalized && /^npx\s+(--yes\s+)?skills\s+(add|install)\b/i.test(normalized));
}

function isSkillsCliDiscovery(command: string): boolean {
	const normalized = normalizedSingleCommand(command);
	return Boolean(normalized && /^npx\s+(--yes\s+)?skills\s+(find|search|list|info|show)\b/i.test(normalized));
}

function isNpxPackageExecution(command: string): boolean {
	const normalized = normalizedSingleCommand(command);
	return Boolean(normalized && /^npx\s+(--yes\s+)?(?!skills\b)\S+/i.test(normalized));
}

function isVerificationCommand(command: string): boolean {
	const normalized = normalizedSingleCommand(command);
	if (!normalized) return false;
	return (
		/^cargo\s+(check|test|clippy|nextest\s+run)\b/i.test(normalized) ||
		/^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|lint|typecheck|check|build))\b/i.test(normalized) ||
		/^python3?\s+-m\s+pytest\b/i.test(normalized) ||
		/^pytest\b/i.test(normalized) ||
		/^go\s+test\b/i.test(normalized) ||
		/^mvn\s+test\b/i.test(normalized) ||
		/^(gradle|\.\/gradlew)\s+test\b/i.test(normalized)
	);
}

function isPackageInstallationCommand(command: string): boolean {
	const normalized = normalizedSingleCommand(command);
	if (!normalized) return false;
	return (
		/^(npm|pnpm|yarn|bun)\s+(install|add|update|upgrade)\b/i.test(normalized) ||
		/^pip3?\s+install\b/i.test(normalized) ||
		/^python3?\s+-m\s+pip\s+install\b/i.test(normalized) ||
		/^uv\s+(add|remove|sync|pip\s+install)\b/i.test(normalized) ||
		/^cargo\s+install\b/i.test(normalized) ||
		/^go\s+install\b/i.test(normalized) ||
		/^gem\s+install\b/i.test(normalized) ||
		/^composer\s+(install|update|require)\b/i.test(normalized)
	);
}

function hasNetworkOrExternalCommand(command: string): boolean {
	return (/\bcurl\b/i.test(command) && !isLocalLoopbackCurlCommand(command)) ||
		/\b(wget|scp|sftp|ssh|rsync|nc|netcat|telnet|ftp)\b/i.test(command) ||
		/\bgit\s+(push|pull|fetch|clone)\b/i.test(command) ||
		/\bgh\s+(auth|api|repo|release)\b/i.test(command);
}

function isHumanRiskBash(command: string): boolean {
	return /\b(rm\s+(-rf?|--recursive|.*\*)|dd\b|mkfs|chmod\b|chown\b|sudo\b|su\b|systemctl\b|service\b|mount\b|umount\b|git\s+(reset|clean|rebase|pull|push|checkout|switch|merge)\b)\b/i.test(command);
}

function isSimpleRm(command: string): boolean {
	return /^\s*rm\s+(--\s+)?[^\s;&|<>`$()]+\s*$/i.test(command);
}

function simpleRmTarget(command: string, cwd: string): string | undefined {
	if (!isSimpleRm(command)) return undefined;
	const path = command.trim().replace(/^rm\s+(--\s+)?/i, "");
	return resolveTarget(cwd, path);
}

function absolutePathsInCommand(command: string): string[] {
	const paths: string[] = [];
	const pathPattern = /\/[^\s'"`|;&<>$()]+/g;
	for (const match of command.matchAll(pathPattern)) {
		const index = match.index ?? 0;
		const before = command.slice(Math.max(0, index - 16), index);
		if (/[a-z][a-z0-9+.-]:$/i.test(before)) continue;
		paths.push(match[0]);
	}
	return paths;
}

function hasParentTraversalPath(command: string): boolean {
	return /(^|[\s'"=])\.\.(?:\/|$)/.test(command);
}

function hasSensitivePathReference(command: string): boolean {
	return /(^|[\s'"=])(?:\.\/)?(?:[^\s'"`|;&<>$()]+\/)?(?:\.env(?:\.[^\s'"`|;&<>$()]*)?|id_rsa|id_ed25519|id_ecdsa)(?=$|[\s'"`|;&<>$()])/i.test(command) ||
		/(^|[\\/])(?:\.ssh|\.gnupg|\.password-store)(?=$|[\\/])/i.test(command);
}

function isTrustedProjectShellCommand(command: string, cwd: string, projectRoot: string): boolean {
	const normalized = stripHarmlessShellNoise(command.trim());
	if (!normalized || !isPathInsideRoot(cwd, projectRoot)) return false;
	if (hasUnsafeShellControlSyntax(normalized)) return false;
	if (hasNetworkOrExternalCommand(normalized)) return false;
	if (isPackageInstallationCommand(normalized) || isNpxPackageExecution(normalized) || isSkillsCliInstall(normalized)) return false;
	if (/\b(sudo|su|dd|mkfs|chmod|chown|systemctl|service|mount|umount|docker|podman|kubectl)\b/i.test(normalized)) return false;
	if (/\bgit\s+(reset|clean|rebase|merge|checkout|switch)\b/i.test(normalized)) return false;
	if (/\brm\s+(-rf?|--recursive|.*\*)\b/i.test(normalized)) return false;
	if (hasParentTraversalPath(normalized) || hasSensitivePathReference(normalized)) return false;
	return absolutePathsInCommand(normalized).every((path) => isPathInsideRoot(path, projectRoot) && !isSensitivePath(path));
}

export function isTrustedProjectEligible(
	preflight: PreflightDecision,
	call: ToolPreflightInput,
	projectRoot: string,
): boolean {
	if (preflight.action === "allow" || !preflight.mutation) return false;
	if (preflight.reason.startsWith("previous user denial")) return false;

	if (call.toolName === "edit" || call.toolName === "write") {
		if (!preflight.targetPaths?.length) return false;
		return preflight.targetPaths.every((path) => isPathInsideRoot(path, projectRoot) && !isSensitivePath(path));
	}

	if (call.toolName === "bash") {
		const command = String(call.input.command ?? "");
		return isTrustedProjectShellCommand(command, call.cwd, projectRoot);
	}

	return false;
}

export function applyTrustedProjectGrant(
	preflight: PreflightDecision,
	call: ToolPreflightInput,
	projectRoot: string,
): PreflightDecision {
	if (!isTrustedProjectEligible(preflight, call, projectRoot)) return preflight;
	return { ...preflight, action: "allow", reason: "trusted project grant" };
}

export function applyTrustedCommandGrant(
	preflight: PreflightDecision,
	call: ToolPreflightInput,
	projectRoot: string,
	trustedCommands: TrustedCommandMemory,
): PreflightDecision {
	if (call.toolName !== "bash") return preflight;
	const command = typeof call.input.command === "string" ? call.input.command : "";
	if (!trustedCommands.isTrusted(projectRoot, command)) return preflight;
	if (!isTrustedProjectEligible(preflight, call, projectRoot)) return preflight;
	return { ...preflight, action: "allow", reason: "trusted project command grant" };
}

export function isTrustedToolEligible(preflight: PreflightDecision, call: ToolPreflightInput): boolean {
	if (preflight.action === "allow") return false;
	const normalized = normalizeToolName(call.toolName);
	if (CORE_MUTATING_TOOL_NAMES.has(normalized)) return false;
	if (isReadOnlyToolName(call.toolName) || isSafeAgentMetaToolName(call.toolName)) return false;
	return preflight.reason === `unknown mutability for tool ${call.toolName}`;
}

export function applyTrustedToolGrant(
	preflight: PreflightDecision,
	call: ToolPreflightInput,
	trustedTools: TrustedToolMemory,
): PreflightDecision {
	if (!isTrustedToolEligible(preflight, call)) return preflight;
	if (!trustedTools.isTrusted(call.toolName)) return preflight;
	return { ...preflight, action: "allow", reason: "trusted session tool grant" };
}

function normalizeEditInput(input: JsonRecord): EditInput | undefined {
	const path = typeof input.path === "string" ? input.path : undefined;
	if (!path) return undefined;
	if (Array.isArray(input.edits)) {
		const edits = input.edits.filter(
			(edit): edit is { oldText: string; newText: string } =>
				isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string",
		);
		if (edits.length > 0 && edits.length === input.edits.length) return { path, edits };
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return { path, edits: [{ oldText: input.oldText, newText: input.newText }] };
	}
	return undefined;
}

export function summarizeEditInput(input: EditInput, currentContent: string | undefined): MutationSummary {
	const removedChars = input.edits.reduce((total, edit) => total + edit.oldText.length, 0);
	const addedChars = input.edits.reduce((total, edit) => total + edit.newText.length, 0);
	const removedLines = input.edits.reduce((total, edit) => total + lineCount(edit.oldText), 0);
	const addedLines = input.edits.reduce((total, edit) => total + lineCount(edit.newText), 0);
	const oldCombined = input.edits.map((edit) => edit.oldText).join("\n--- edit ---\n");
	const newCombined = input.edits.map((edit) => edit.newText).join("\n--- edit ---\n");
	const current = currentContent ?? "";
	const touchesWholeExistingFile = current.length > 0 && input.edits.some((edit) => edit.oldText === current);
	const emptiesExistingFile = current.length > 0 && input.edits.some((edit) => edit.oldText === current && edit.newText.trim() === "");
	const isHuge =
		input.edits.length > 8 ||
		removedLines + addedLines > 200 ||
		removedChars + addedChars > 12000 ||
		(current.length > 2000 && touchesWholeExistingFile);
	const isSmall =
		input.edits.length <= 3 &&
		removedLines + addedLines <= 80 &&
		removedChars + addedChars <= 4000 &&
		!touchesWholeExistingFile &&
		!emptiesExistingFile;
	const reason = `editCount=${input.edits.length}, +/-lines=${addedLines}/${removedLines}, +/-chars=${addedChars}/${removedChars}`;
	const excerpt = `old:\n${truncate(oldCombined)}\n\nnew:\n${truncate(newCombined)}`;
	return {
		path: input.path,
		editCount: input.edits.length,
		addedLines,
		removedLines,
		addedChars,
		removedChars,
		touchesWholeExistingFile,
		emptiesExistingFile,
		isHuge,
		isSmall,
		reason,
		excerpt,
	};
}

function summarizeWriteInput(path: string, newContent: string, currentContent: string | undefined): MutationSummary {
	const oldContent = currentContent ?? "";
	const exists = currentContent !== undefined;
	const addedLines = lineCount(newContent);
	const removedLines = lineCount(oldContent);
	const addedChars = newContent.length;
	const removedChars = oldContent.length;
	const emptiesExistingFile = exists && oldContent.length > 0 && newContent.trim() === "";
	const touchesWholeExistingFile = exists;
	const changedChars = Math.abs(newContent.length - oldContent.length);
	const isHuge = addedLines + removedLines > 250 || addedChars + removedChars > 16000 || (exists && oldContent.length > 2000 && changedChars > 1000);
	const isSmall = exists && !emptiesExistingFile && addedLines + removedLines <= 100 && addedChars + removedChars <= 8000 && changedChars <= 1500;
	const reason = `write existing=${exists}, +/-lines=${addedLines}/${removedLines}, +/-chars=${addedChars}/${removedChars}`;
	const excerpt = `old:\n${truncate(oldContent)}\n\nnew:\n${truncate(newContent)}`;
	return {
		path,
		editCount: 1,
		addedLines,
		removedLines,
		addedChars,
		removedChars,
		touchesWholeExistingFile,
		emptiesExistingFile,
		isHuge,
		isSmall,
		reason,
		excerpt,
	};
}

function approvalPrompt(toolName: string, reason: string, git: GitFileState | undefined, summary?: MutationSummary): string {
	return [
		`tool=${toolName}`,
		`reason=${reason}`,
		git ? `git=inside:${git.insideWorkTree} tracked:${git.tracked} clean:${git.clean} status:${git.status ?? ""}` : "git=unknown",
		summary
			? `path=${summary.path}\n${summary.reason}\nwholeFile=${summary.touchesWholeExistingFile} empties=${summary.emptiesExistingFile} huge=${summary.isHuge} small=${summary.isSmall}\n${summary.excerpt}`
			: "",
	].join("\n");
}

export async function classifyToolPreflight(
	call: ToolPreflightInput,
	deps: PolicyDeps,
): Promise<PreflightDecision> {
	if (isSafeAgentMetaToolName(call.toolName)) {
		return { action: "allow", reason: "safe agent meta tool" };
	}
	if (isReadOnlyToolName(call.toolName)) {
		return { action: "allow", reason: "read-only tool" };
	}

	if (call.toolName === "bash") {
		const command = String(call.input.command ?? "");
		if (isSkillsCliDiscovery(command)) return { action: "allow", reason: "skills CLI discovery command" };
		if (isVerificationCommand(command)) return { action: "allow", reason: "known verification command" };
		if (isLocalLoopbackCurlCommand(command)) return { action: "allow", reason: "local loopback curl command" };
		if (isObviouslyReadOnly(command)) return { action: "allow", reason: "read-only bash command" };
		if (hasNetworkOrExternalCommand(command)) {
			return mutationDecision({
				action: "ask",
				reason: "network or external shell command requires human confirmation",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, []);
		}
		if (isSkillsCliInstall(command)) {
			return mutationDecision({
				action: "ask",
				reason: "skills CLI install requires human confirmation",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, []);
		}
		if (isNpxPackageExecution(command)) {
			return mutationDecision({
				action: "ask",
				reason: "npx package execution requires human confirmation",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, []);
		}
		if (isPackageInstallationCommand(command)) {
			return mutationDecision({
				action: "ask",
				reason: "package installation requires human confirmation",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, []);
		}
		if (isSimpleRm(command)) {
			return mutationDecision({
				action: "sidecar",
				reason: "simple file deletion requires approval sidecar",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, uniquePaths([simpleRmTarget(command, call.cwd)]));
		}
		if (isHumanRiskBash(command)) {
			return mutationDecision({
				action: "ask",
				reason: "high-impact shell command requires human confirmation",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, []);
		}
		if (hasUnsafeShellControlSyntax(command)) {
			return mutationDecision({
				action: "sidecar",
				reason: "shell redirection, substitution, or backgrounding requires approval sidecar",
				approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
			}, []);
		}
		return mutationDecision({
			action: "sidecar",
			reason: "unclassified shell command requires approval sidecar",
			approvalPrompt: approvalPrompt("bash", `command=${command}`, undefined),
		}, []);
	}

	if (call.toolName === "edit") {
		const edit = normalizeEditInput(call.input);
		if (!edit) return { action: "ask", reason: "malformed edit input" };
		const target = resolveTarget(call.cwd, edit.path);
		const current = await deps.readFile(target);
		const git = await deps.gitState(call.cwd, target);
		const summary = summarizeEditInput(edit, current);

		if (summary.emptiesExistingFile) {
			return mutationDecision({
				action: "ask",
				reason: "edit empties an existing file",
				approvalPrompt: approvalPrompt("edit", "empty existing file", git, summary),
			}, [target]);
		}
		if (summary.isHuge) {
			return mutationDecision({
				action: "ask",
				reason: summary.editCount > 8 ? "many edit hunks require human confirmation" : "large edit requires human confirmation",
				approvalPrompt: approvalPrompt("edit", "large edit", git, summary),
			}, [target]);
		}
		if (git.insideWorkTree && git.tracked && git.clean && summary.isSmall) {
			return mutationDecision({ action: "allow", reason: "small edit to clean tracked file is reversible by git" }, [target]);
		}
		return mutationDecision({
			action: "sidecar",
			reason: git.clean ? "small edit requires approval sidecar" : "dirty or untracked file requires approval sidecar",
			approvalPrompt: approvalPrompt("edit", "small edit not auto-approved", git, summary),
		}, [target]);
	}

	if (call.toolName === "write") {
		const path = typeof call.input.path === "string" ? call.input.path : undefined;
		const content = typeof call.input.content === "string" ? call.input.content : undefined;
		if (!path || content === undefined) return { action: "ask", reason: "malformed write input" };
		const target = resolveTarget(call.cwd, path);
		const exists = await deps.pathExists(target);
		const current = exists ? await deps.readFile(target) : undefined;
		const git = await deps.gitState(call.cwd, target);
		const summary = summarizeWriteInput(path, content, current);

		if (!exists) {
			if (summary.isHuge) {
				return mutationDecision({
					action: "ask",
					reason: "large new file requires human confirmation",
					approvalPrompt: approvalPrompt("write", "large new file", git, summary),
				}, [target]);
			}
			return mutationDecision({
				action: "sidecar",
				reason: "new file creation requires approval sidecar",
				approvalPrompt: approvalPrompt("write", "new file", git, summary),
			}, [target]);
		}
		if (summary.emptiesExistingFile) {
			return mutationDecision({
				action: "ask",
				reason: "write empties an existing file",
				approvalPrompt: approvalPrompt("write", "empty existing file", git, summary),
			}, [target]);
		}
		if (summary.isHuge) {
			return mutationDecision({
				action: "ask",
				reason: "large overwrite requires human confirmation",
				approvalPrompt: approvalPrompt("write", "large overwrite", git, summary),
			}, [target]);
		}
		if (git.insideWorkTree && git.tracked && git.clean && summary.isSmall) {
			return mutationDecision({ action: "allow", reason: "small overwrite of clean tracked file is reversible by git" }, [target]);
		}
		return mutationDecision({
			action: "sidecar",
			reason: git.clean ? "overwrite requires approval sidecar" : "dirty or untracked overwrite requires approval sidecar",
			approvalPrompt: approvalPrompt("write", "overwrite not auto-approved", git, summary),
		}, [target]);
	}

	return { action: "sidecar", reason: `unknown mutability for tool ${call.toolName}`, mutation: true };
}

async function defaultReadFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function defaultPathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: 3000 });
		return { ok: true, stdout: String(stdout), stderr: String(stderr) };
	} catch (error) {
		const maybe = error as { stdout?: unknown; stderr?: unknown };
		return { ok: false, stdout: String(maybe.stdout ?? ""), stderr: String(maybe.stderr ?? "") };
	}
}

async function defaultGitState(cwd: string, absolutePath: string): Promise<GitFileState> {
	const root = await git(["rev-parse", "--show-toplevel"], cwd);
	if (!root.ok) return { insideWorkTree: false, tracked: false, clean: false };
	const repoRoot = root.stdout.trim();
	const relPath = relative(repoRoot, absolutePath);
	const tracked = await git(["ls-files", "--error-unmatch", "--", relPath], repoRoot);
	const status = await git(["status", "--porcelain=v1", "--", relPath], repoRoot);
	return {
		insideWorkTree: true,
		tracked: tracked.ok,
		clean: status.ok && status.stdout.trim().length === 0,
		status: status.stdout.trim(),
	};
}

async function defaultProjectRoot(cwd: string): Promise<string> {
	const root = await git(["rev-parse", "--show-toplevel"], cwd);
	return root.ok && root.stdout.trim() ? root.stdout.trim() : resolve(cwd);
}

export function formatApprovalHttpError(status: number, body: string): string {
	const detail = body.trim();
	return `approval sidecar returned HTTP ${status}${detail ? `: ${truncate(detail, 500)}` : ""}`;
}

export function parseApprovalDecision(text: string): PreflightDecision {
	const trimmed = text.trim();
	if (/^\s*ALLOW\b/i.test(trimmed)) return { action: "allow", reason: trimmed || "approved" };
	if (/^\s*ASK\b/i.test(trimmed)) return { action: "ask", reason: trimmed };
	if (/^\s*DENY\b/i.test(trimmed)) return { action: "ask", reason: `approval sidecar denied, escalating to user: ${trimmed}` };
	return { action: "ask", reason: `approval sidecar returned an unclear decision: ${trimmed || "(empty)"}` };
}

export function formatHumanPrompt(decision: PreflightDecision): string {
	return [
		decision.reason,
		decision.approvalPrompt ? truncate(decision.approvalPrompt, 1600) : "",
		"Allow this operation?",
	]
		.filter(Boolean)
		.join("\n\n");
}

export function formatTrustStatus(projectRoot: string, trustedCommandCount: number): string {
	return [
		`Trusted project: ${projectRoot}`,
		"Auto-allow: reads, in-project edits/writes, normal project-local shell",
		"Still asks: network, secrets, package installs, system changes, high-risk git",
		`Trusted commands: ${trustedCommandCount}`,
	].join(" | ");
}

type ApprovalDoctorReportInput = {
	cwd: string;
	modelId?: string;
	projectRoot: (cwd: string) => Promise<string>;
	trustedProjects: TrustedProjectMemory;
	trustedCommands: TrustedCommandMemory;
	decisionLog?: ApprovalDecisionLog;
	deps: PolicyDeps;
};

export async function buildApprovalDoctorReport(input: ApprovalDoctorReportInput): Promise<string[]> {
	const projectRoot = await input.projectRoot(input.cwd);
	const trustedCommands = input.trustedCommands.commands(projectRoot);
	const samples: Array<[string, ToolPreflightInput]> = [
		["sample read-only git", { toolName: "bash", input: { command: "git status --short" }, cwd: input.cwd }],
		["sample project command", { toolName: "bash", input: { command: "npm run format" }, cwd: input.cwd }],
		["sample network command", { toolName: "bash", input: { command: "curl https://example.test" }, cwd: input.cwd }],
	];
	const sampleLines: string[] = [];
	for (const [label, call] of samples) {
		let decision = await classifyToolPreflight(call, input.deps);
		if (input.trustedProjects.isTrusted(projectRoot)) {
			decision = applyTrustedProjectGrant(decision, call, projectRoot);
		}
		decision = applyTrustedCommandGrant(decision, call, projectRoot, input.trustedCommands);
		sampleLines.push(`${label}: ${decision.action} (${decision.reason})`);
	}
	const recent = input.decisionLog?.entries().slice(-5) ?? [];

	return [
		`Pi approval profile: ${APPROVAL_PROFILE}`,
		`Current cwd: ${input.cwd}`,
		`Detected project root: ${projectRoot}`,
		`Current model: ${input.modelId ?? "(unknown)"}`,
		`Primary endpoint: ${PRIMARY.baseUrl} model=${PRIMARY.model}`,
		`Approval sidecar: ${APPROVAL.baseUrl} model=${APPROVAL.model}`,
		`Trusted projects: ${input.trustedProjects.roots().join(", ") || "(none)"}`,
		`Trusted commands in project: ${trustedCommands.join(", ") || "(none)"}`,
		recent.length > 0 ? "Recent decisions:" : "Recent decisions: (none)",
		...recent.map((entry) => `- ${entry.toolName} -> ${entry.action}: ${entry.reason} [cwd=${entry.cwd}]`),
		"Sample decisions:",
		...sampleLines,
	];
}

async function askApprovalModel(preflight: PreflightDecision, cwd: string): Promise<PreflightDecision> {
	const body = {
		model: APPROVAL.model,
		stream: false,
		temperature: 0,
		max_tokens: 32,
		messages: [
			{
				role: "system",
				content:
					"You are a conservative command and file-mutation safety classifier for a local coding agent. Reply exactly with 'ALLOW: reason', 'ASK: reason', or 'DENY: reason'. ALLOW only when the operation is clearly low-risk and reversible. ASK when unsure, user-intent-dependent, large, destructive, privacy-sensitive, irreversible, or context is insufficient. DENY only for categorically unsafe operations, not for ambiguity or unfamiliar tools.",
			},
			{
				role: "user",
				content: `cwd: ${cwd}\npreflight: ${preflight.reason}\n${preflight.approvalPrompt ?? ""}`,
			},
		],
	};

	let response: Response;
	try {
		response = await fetch(`${APPROVAL.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer local" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(5000),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { action: "ask", reason: `approval sidecar request failed: ${message}` };
	}
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return { action: "ask", reason: formatApprovalHttpError(response.status, text) };
	}

	const payload = (await response.json()) as JsonRecord;
	const choices = payload.choices;
	const first = Array.isArray(choices) ? choices[0] : undefined;
	const text = isRecord(first) && isRecord(first.message) ? String(first.message.content ?? "") : "";
	return parseApprovalDecision(text);
}

async function askHuman(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1], decision: PreflightDecision): Promise<PreflightDecision> {
	if (!ctx.hasUI) return { action: "deny", reason: `${decision.reason} (no UI available for escalation)` };
	const choice = await ctx.ui.select(formatHumanPrompt(decision), ["No", "Yes"]);
	return choice === "Yes" ? { action: "allow", reason: "approved by user" } : { action: "deny", reason: "blocked by user" };
}

function formatProjectTrustPrompt(projectRoot: string, decision: PreflightDecision): string {
	return [
		`Allow Pi to work inside this project for this session?\n\nProject: ${projectRoot}`,
		"This auto-approves in-project file edits/writes and normal project-local shell commands.",
		"External paths, system commands, network uploads, package installs, credentials, and high-risk git operations will still require approval.",
		decision.approvalPrompt ? `Current operation:\n${truncate(decision.approvalPrompt, 1200)}` : `Current operation: ${decision.reason}`,
	].join("\n\n");
}

async function askProjectTrust(
	ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	projectRoot: string,
	decision: PreflightDecision,
	call: ToolPreflightInput,
): Promise<PreflightDecision> {
	if (!ctx.hasUI) return decision;
	const options = call.toolName === "bash"
		? ["Allow project", "Allow command in project", "Allow once", "No"]
		: ["Allow project", "Allow once", "No"];
	const choice = await ctx.ui.select(formatProjectTrustPrompt(projectRoot, decision), options);
	if (choice === "Allow project") return { ...decision, action: "allow", reason: "trusted project grant" };
	if (choice === "Allow command in project") return { ...decision, action: "allow", reason: "trusted project command grant" };
	if (choice === "Allow once") return { ...decision, action: "allow", reason: "approved by user for this operation" };
	return { ...decision, action: "deny", reason: "blocked by user" };
}

function formatToolTrustPrompt(toolName: string, decision: PreflightDecision): string {
	return [
		`Allow Pi to use this tool for this session?\n\nTool: ${toolName}`,
		"This is only for this Pi session and only for this exact tool name.",
		"Core tools such as bash, edit, and write cannot be globally trusted this way.",
		decision.approvalPrompt ? `Current operation:\n${truncate(decision.approvalPrompt, 1200)}` : `Current operation: ${decision.reason}`,
	].join("\n\n");
}

async function askToolTrust(
	ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	call: ToolPreflightInput,
	decision: PreflightDecision,
): Promise<PreflightDecision> {
	if (!ctx.hasUI) return decision;
	const choice = await ctx.ui.select(formatToolTrustPrompt(call.toolName, decision), [
		"Allow tool for session",
		"Allow once",
		"No",
	]);
	if (choice === "Allow tool for session") return { ...decision, action: "allow", reason: "trusted session tool grant" };
	if (choice === "Allow once") return { ...decision, action: "allow", reason: "approved by user for this operation" };
	return { ...decision, action: "deny", reason: "blocked by user" };
}

function setApprovalStatus(
	ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	projectRoot: string,
	trustedCommands: TrustedCommandMemory,
) {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("hermes-approval", formatTrustStatus(projectRoot, trustedCommands.commands(projectRoot).length));
}

async function showApprovalDoctor(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	trustedProjects: TrustedProjectMemory,
	trustedCommands: TrustedCommandMemory,
	decisionLog: ApprovalDecisionLog,
	deps: PolicyDeps,
) {
	const lines = await buildApprovalDoctorReport({
		cwd: ctx.cwd,
		modelId: ctx.model?.id,
		projectRoot: defaultProjectRoot,
		trustedProjects,
		trustedCommands,
		decisionLog,
		deps,
	});
	if (ctx.hasUI) {
		ctx.ui.setWidget("hermes-approval-doctor", lines, { placement: "belowEditor" });
		ctx.ui.notify("Approval doctor report shown below the editor", "info");
	}
}

export default async function (pi: ExtensionAPI) {
	const [primaryContext, approvalContext] = await Promise.all([
		detectContext(PRIMARY.baseUrl, PRIMARY.model, PRIMARY.fallbackContext),
		detectContext(APPROVAL.baseUrl, APPROVAL.model, APPROVAL.fallbackContext),
	]);

	registerHermesProvider(pi, PRIMARY, primaryContext);
	registerHermesProvider(pi, APPROVAL, approvalContext);

	const deps: PolicyDeps = {
		readFile: defaultReadFile,
		pathExists: defaultPathExists,
		gitState: defaultGitState,
	};
	const mutationDenials = createMutationDenialMemory();
	const trustedProjects = createTrustedProjectMemory();
	const trustedCommands = createTrustedCommandMemory();
	const trustedTools = createTrustedToolMemory();
	const decisionLog = createApprovalDecisionLog();

	pi.registerCommand("approval-doctor", {
		description: "Show Hermes approval policy, trust state, and sample decisions",
		handler: async (_args, ctx) => {
			await showApprovalDoctor(ctx, trustedProjects, trustedCommands, decisionLog, deps);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const call = { toolName: event.toolName, input: event.input as JsonRecord, cwd: ctx.cwd };
		const preflight = await classifyToolPreflight(
			call,
			deps,
		);

		let decision = applyMutationDenialMemory(preflight, mutationDenials);
		const projectRoot = await defaultProjectRoot(ctx.cwd);
		if (trustedProjects.isTrusted(projectRoot)) {
			decision = applyTrustedProjectGrant(decision, call, projectRoot);
		}
			if (decision.action !== "allow") {
				decision = applyTrustedCommandGrant(decision, call, projectRoot, trustedCommands);
			}
			if (decision.action !== "allow") {
				decision = applyTrustedToolGrant(decision, call, trustedTools);
			}
			if (decision.action !== "allow" && isTrustedToolEligible(decision, call)) {
				decision = await askToolTrust(ctx, call, decision);
				if (decision.reason === "trusted session tool grant") {
					trustedTools.grant(call.toolName);
				}
			}
			if (decision.action !== "allow" && isTrustedProjectEligible(decision, call, projectRoot)) {
			decision = await askProjectTrust(ctx, projectRoot, decision, call);
			if (decision.reason === "trusted project grant") {
				trustedProjects.grant(projectRoot);
				setApprovalStatus(ctx, projectRoot, trustedCommands);
			}
			if (decision.reason === "trusted project command grant" && call.toolName === "bash") {
				trustedCommands.grant(projectRoot, String(call.input.command ?? ""));
				setApprovalStatus(ctx, projectRoot, trustedCommands);
			}
		}
		if (decision.action === "sidecar") decision = await askApprovalModel(preflight, ctx.cwd);
		if (decision.action === "ask") {
			const humanDecision = await askHuman(ctx, decision);
			if (preflight.targetPaths?.length && humanDecision.reason === "blocked by user") {
				mutationDenials.record(preflight.targetPaths, humanDecision.reason);
			}
			if (preflight.targetPaths?.length && humanDecision.action === "allow") {
				mutationDenials.clear(preflight.targetPaths);
			}
			decision = humanDecision;
		}

		decisionLog.record({
			cwd: ctx.cwd,
			toolName: event.toolName,
			action: decision.action,
			reason: decision.reason,
		});

		if (decision.action === "allow") return undefined;
		return { block: true, reason: decision.reason };
	});
}
