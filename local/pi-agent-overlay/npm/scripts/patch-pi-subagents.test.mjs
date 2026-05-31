import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { patchPiSubagents } from "./patch-pi-subagents.mjs";

const foregroundOriginal = `
\t\tif (controlConfig.enabled) {
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
`;

const renderOriginal = `
function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">): number | undefined {
\tif (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
\treturn progress.lastActivityAt;
}

function widgetJobName(job: AsyncJobState): string {
\treturn job.mode ?? "subagent";
}

function widgetActivity(job: AsyncJobState): string {
\tconst facts: string[] = [];
\tif (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined) facts.push(\`\${job.currentTool} \${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}\`);
\telse if (job.currentTool) facts.push(job.currentTool);
\tconst activity = buildLiveStatusLine(job, job.updatedAt);
\treturn activity ?? facts.join(" · ");
}

function widgetStats(job: AsyncJobState, theme: Theme): string {
\tconst parts: string[] = [];
\tif (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
\treturn statJoin(theme, parts);
}

function widgetStepStats(theme: Theme, step: NonNullable<AsyncJobState["steps"]>[number]): string {
\treturn statJoin(theme, [
\t\tstep.durationMs !== undefined ? formatDuration(step.durationMs) : "",
\t]);
}

\t\t\`  \${theme.fg("dim", \`⎿  \${widgetActivity(job)}\`)}\`,
\t\t...formatNestedWidgetLines(job.nestedChildren, theme, width, expanded, job.updatedAt).map((line) => \`  \${line}\`),
\tconst activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
\tif (activity) lines.push(\`    \${theme.fg("dim", \`⎿  \${activity}\`)}\`);
\tfor (const nestedLine of formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt)) {
\t\tlines.push(\`    \${nestedLine}\`);
\t}
\t\t\tconst liveStatus = buildLiveStatusLine(step, job.updatedAt);
\tfor (const nestedLine of formatNestedWidgetLines(unattached, theme, width, expanded, job.updatedAt)) {
\t\tlines.push(\`  \${nestedLine}\`);
\t}
\t\tconst activity = widgetStepActivityLine(step, width, false, job.updatedAt);
\t\tfor (const nestedLine of formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt)) lines.push(\`    \${nestedLine}\`);
`;

const trackerOriginal = `
export function createAsyncJobTracker(pi, state, asyncDirRoot, options = {}) {
\tconst completionRetentionMs = options.completionRetentionMs ?? 10000;
\tconst pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
\tconst resultsDir = options.resultsDir ?? RESULTS_DIR;

\tconst ensurePoller = () => {
\t\tstate.poller = setInterval(() => {
\t\t\tlet widgetChanged = false;
\t\t\tfor (const job of state.asyncJobs.values()) {
\t\t\t\tif (widgetRenderKey(job) !== widgetStateBefore) widgetChanged = true;
\t\t\t}

\t\t\tif (widgetChanged && state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
\t\t}, pollIntervalMs);
\t};
}
`;

async function writeFixture(root) {
	const packageRoot = path.join(root, "node_modules", "pi-subagents");
	await mkdir(path.join(packageRoot, "src", "runs", "foreground"), { recursive: true });
	await mkdir(path.join(packageRoot, "src", "tui"), { recursive: true });
	await mkdir(path.join(packageRoot, "src", "runs", "background"), { recursive: true });
	await writeFile(path.join(packageRoot, "src", "runs", "foreground", "execution.ts"), foregroundOriginal);
	await writeFile(path.join(packageRoot, "src", "tui", "render.ts"), renderOriginal);
	await writeFile(path.join(packageRoot, "src", "runs", "background", "async-job-tracker.ts"), trackerOriginal);
	return packageRoot;
}

test("patches pi-subagents live timers and remains idempotent", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-subagents-patch-"));
	const packageRoot = await writeFixture(root);

	patchPiSubagents({ packageRoot });
	patchPiSubagents({ packageRoot });

	const execution = await readFile(path.join(packageRoot, "src", "runs", "foreground", "execution.ts"), "utf8");
	assert.match(execution, /fireUpdate\(\);/);
	assert.match(execution, /if \(controlConfig\.enabled\) updateActivityState\(now\);/);
	assert.doesNotMatch(execution, /if \(updateActivityState\(now\)\) \{/);

	const render = await readFile(path.join(packageRoot, "src", "tui", "render.ts"), "utf8");
	assert.match(render, /function widgetSnapshotNow/);
	assert.match(render, /progress\.status === "running"/);
	assert.match(render, /widgetStepDurationMs\(step\)/);

	const tracker = await readFile(path.join(packageRoot, "src", "runs", "background", "async-job-tracker.ts"), "utf8");
	assert.match(tracker, /lastLiveRenderAt/);
	assert.match(tracker, /shouldLiveRender/);
});
