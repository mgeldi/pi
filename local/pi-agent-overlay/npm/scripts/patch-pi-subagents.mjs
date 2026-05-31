#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = path.resolve(scriptDir, "..", "node_modules", "pi-subagents");

function replaceOnce(source, search, replacement, label) {
	if (source.includes(replacement)) return source;
	if (!source.includes(search)) {
		throw new Error(`Could not apply pi-subagents patch: missing ${label}`);
	}
	return source.replace(search, replacement);
}

function patchFile(packageRoot, relativePath, patcher) {
	const filePath = path.join(packageRoot, relativePath);
	const before = readFileSync(filePath, "utf8");
	const after = patcher(before);
	if (after !== before) writeFileSync(filePath, after);
}

function patchForegroundExecution(packageRoot) {
	patchFile(packageRoot, "src/runs/foreground/execution.ts", (source) => {
		let next = source;
		next = replaceOnce(next, `import {
\tgetFinalOutput,
\tfindLatestSessionFile,
\tdetectSubagentError,
\textractToolArgsPreview,
\textractTextFromContent,
} from "../../shared/utils.ts";
`, `import {
\tgetFinalOutput,
\tfindLatestSessionFile,
\tdetectSubagentError,
\textractToolArgsPreview,
\textractTextFromContent,
} from "../../shared/utils.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
`, "foreground session token import");

		next = replaceOnce(next, `function sumUsage(target: Usage, source: Usage): void {
\ttarget.input += source.input;
\ttarget.output += source.output;
\ttarget.cacheRead += source.cacheRead;
\ttarget.cacheWrite += source.cacheWrite;
\ttarget.cost += source.cost;
\ttarget.turns += source.turns;
}
`, `function sumUsage(target: Usage, source: Usage): void {
\ttarget.input += source.input;
\ttarget.output += source.output;
\ttarget.cacheRead += source.cacheRead;
\ttarget.cacheWrite += source.cacheWrite;
\ttarget.cost += source.cost;
\ttarget.turns += source.turns;
}

function updateProgressTokensFromSession(progress: AgentProgress, result: SingleResult, sessionDir: string | undefined): boolean {
\tif (!sessionDir) return false;
\tconst sessionTokens = parseSessionTokens(sessionDir);
\tif (!sessionTokens || sessionTokens.total <= 0 || sessionTokens.total <= progress.tokens) return false;
\tprogress.tokens = sessionTokens.total;
\tresult.usage.input = Math.max(result.usage.input, sessionTokens.input);
\tresult.usage.output = Math.max(result.usage.output, sessionTokens.output);
\treturn true;
}
`, "foreground live session token helper");

		next = replaceOnce(next, `\tresult.progress = progress;
\tconst spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
`, `\tresult.progress = progress;
\tconst sessionTokenDir = options.sessionDir ?? (options.sessionFile ? path.dirname(options.sessionFile) : undefined);
\tconst spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
`, "foreground session token dir");

		next = replaceOnce(next, `\t\tconst fireUpdate = () => {
\t\t\tif (!options.onUpdate || processClosed) return;
\t\t\tprogress.durationMs = Date.now() - startTime;
\t\t\temitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
\t\t};
`, `\t\tconst fireUpdate = () => {
\t\t\tif (!options.onUpdate || processClosed) return;
\t\t\tupdateProgressTokensFromSession(progress, result, sessionTokenDir);
\t\t\tprogress.durationMs = Date.now() - startTime;
\t\t\temitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
\t\t};
`, "foreground live session token refresh");

		next = replaceOnce(next, `\t\tif (controlConfig.enabled) {
\t\t\tactivityTimer = setInterval(() => {
\t\t\t\tif (processClosed || settled || detached) return;
\t\t\t\tconst now = Date.now();
\t\t\t\tif (updateActivityState(now)) {
\t\t\t\t\tprogress.durationMs = now - startTime;
\t\t\t\t\tfireUpdate();
\t\t\t\t}
\t\t\t}, 1000);
\t\t\tactivityTimer.unref?.();
\t\t}
`, `\t\tactivityTimer = setInterval(() => {
\t\t\tif (processClosed || settled || detached) return;
\t\t\tconst now = Date.now();
\t\t\tif (controlConfig.enabled) updateActivityState(now);
\t\t\tprogress.durationMs = now - startTime;
\t\t\tfireUpdate();
\t\t}, 1000);
\t\tactivityTimer.unref?.();
`, "foreground live progress timer");
		return next;
	});
}

function patchRender(packageRoot) {
	patchFile(packageRoot, "src/tui/render.ts", (source) => {
		let next = source;
		next = replaceOnce(next, `function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">): number | undefined {
\tif (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
\treturn progress.lastActivityAt;
}
`, `function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt"> & { status?: AgentProgress["status"] }): number | undefined {
\tif (progress.status === "running") return Date.now();
\tif (progress.lastActivityAt !== undefined) return progress.lastActivityAt;
\tif (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
\treturn undefined;
}
`, "running progress snapshot clock");

		next = replaceOnce(next, `\treturn job.mode ?? "subagent";
}
`, `\treturn job.mode ?? "subagent";
}

function widgetSnapshotNow(job: Pick<AsyncJobState, "status" | "updatedAt">): number | undefined {
\treturn job.status === "running" || job.status === "queued" ? Date.now() : job.updatedAt;
}

function widgetStepDurationMs(step: NonNullable<AsyncJobState["steps"]>[number]): number | undefined {
\tif (step.status === "running" && step.startedAt !== undefined) return Math.max(0, Date.now() - step.startedAt);
\treturn step.durationMs;
}
`, "async widget live clock helpers");

		next = replaceOnce(next, `function widgetActivity(job: AsyncJobState): string {
\tconst facts: string[] = [];
\tif (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined) facts.push(\`\${job.currentTool} \${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}\`);
\telse if (job.currentTool) facts.push(job.currentTool);
`, `function widgetActivity(job: AsyncJobState): string {
\tconst snapshotNow = widgetSnapshotNow(job);
\tconst facts: string[] = [];
\tif (job.currentTool && job.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(\`\${job.currentTool} \${formatDuration(Math.max(0, snapshotNow - job.currentToolStartedAt))}\`);
\telse if (job.currentTool) facts.push(job.currentTool);
`, "async widget activity clock");

		next = replaceOnce(next, `\tconst activity = buildLiveStatusLine(job, job.updatedAt);
`, `\tconst activity = buildLiveStatusLine(job, snapshotNow);
`, "async widget activity status clock");

		next = replaceOnce(next, `\tif (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
`, `\tconst snapshotNow = widgetSnapshotNow(job);
\tif (job.startedAt !== undefined && snapshotNow !== undefined) parts.push(formatDuration(Math.max(0, snapshotNow - job.startedAt)));
`, "async widget stats clock");

		next = replaceOnce(next, `\t\tstep.durationMs !== undefined ? formatDuration(step.durationMs) : "",
`, `\t\twidgetStepDurationMs(step) !== undefined ? formatDuration(widgetStepDurationMs(step)!) : "",
`, "async widget step duration clock");

		next = replaceOnce(next, `\tconst activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
\tif (activity) lines.push(\`    \${theme.fg("dim", \`⎿  \${activity}\`)}\`);
\tfor (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt)) {
`, `\tconst snapshotNow = widgetSnapshotNow(job);
\tconst activity = widgetStepActivityLine(step, width, expanded, snapshotNow);
\tif (activity) lines.push(\`    \${theme.fg("dim", \`⎿  \${activity}\`)}\`);
\tfor (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, snapshotNow)) {
`, "async widget step activity clock");

		next = replaceOnce(next, `\t\t\tconst liveStatus = buildLiveStatusLine(step, job.updatedAt);
`, `\t\t\tconst liveStatus = buildLiveStatusLine(step, snapshotNow);
`, "async widget step live status clock");

		next = replaceOnce(next, `\t\t...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt).map((line) => \`  \${line}\`),
`, `\t\t...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, widgetSnapshotNow(job)).map((line) => \`  \${line}\`),
`, "async widget no-step nested clock");

		next = replaceOnce(next, `\tfor (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt)) {
`, `\tfor (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, widgetSnapshotNow(job))) {
`, "async widget unattached nested clock");

		next = replaceOnce(next, `\t\tconst activity = widgetStepActivityLine(step, width, false, job.updatedAt);
`, `\t\tconst snapshotNow = widgetSnapshotNow(job);
\t\tconst activity = widgetStepActivityLine(step, width, false, snapshotNow);
`, "async compact widget step activity clock");

		next = replaceOnce(next, `\t\tfor (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt)) lines.push(\`    \${nestedLine}\`);
`, `\t\tfor (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, snapshotNow)) lines.push(\`    \${nestedLine}\`);
`, "async compact widget nested clock");

		return next;
	});
}

function patchAsyncTracker(packageRoot) {
	patchFile(packageRoot, "src/runs/background/async-job-tracker.ts", (source) => {
		let next = source;
		next = replaceOnce(next, `\tconst resultsDir = options.resultsDir ?? RESULTS_DIR;
`, `\tconst resultsDir = options.resultsDir ?? RESULTS_DIR;
\tlet lastLiveRenderAt = 0;
`, "async widget live render state");

		next = replaceOnce(next, `\t\t\tif (widgetChanged && state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
`, `\t\t\tconst now = Date.now();
\t\t\tconst hasLiveJobs = Array.from(state.asyncJobs.values()).some((job) => job.status === "running" || job.status === "queued");
\t\t\tconst shouldLiveRender = hasLiveJobs && now - lastLiveRenderAt >= 1000;
\t\t\tif ((widgetChanged || shouldLiveRender) && state.lastUiContext?.hasUI) {
\t\t\t\tlastLiveRenderAt = now;
\t\t\t\trerenderWidget(state.lastUiContext);
\t\t\t}
`, "async widget live rerender");

		return next;
	});
}

export function patchPiSubagents({ packageRoot = defaultPackageRoot } = {}) {
	if (!existsSync(packageRoot)) {
		throw new Error(`pi-subagents package not found at ${packageRoot}`);
	}
	patchForegroundExecution(packageRoot);
	patchRender(packageRoot);
	patchAsyncTracker(packageRoot);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	patchPiSubagents();
	console.log(`Patched pi-subagents at ${defaultPackageRoot}`);
}
