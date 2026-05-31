import type { AgentTool } from "@earendil-works/pi-agent-core";
import { appendFile as fsAppendFile, mkdir as fsMkdir } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const appendSchema = Type.Object({
	path: Type.String({ description: "Path to the file to append to (relative or absolute)" }),
	content: Type.String({ description: "Content to append to the file" }),
});

export type AppendToolInput = Static<typeof appendSchema>;

/**
 * Pluggable operations for the append tool.
 * Override these to delegate file appends to remote systems (for example SSH).
 */
export interface AppendOperations {
	/** Append content to a file */
	appendFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultAppendOperations: AppendOperations = {
	appendFile: (path, content) => fsAppendFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface AppendToolOptions {
	/** Custom operations for file appending. Default: local filesystem */
	operations?: AppendOperations;
}

export function createAppendToolDefinition(
	cwd: string,
	options?: AppendToolOptions,
): ToolDefinition<typeof appendSchema, undefined> {
	const ops = options?.operations ?? defaultAppendOperations;
	return {
		name: "append",
		label: "append",
		description: "Append content to a file. Creates the file and parent directories if needed.",
		promptSnippet: "Append content to existing files",
		promptGuidelines: [
			"Use append to continue large generated files in smaller chunks after an initial write.",
			"Before continuing a partial large file, inspect the file tail and append only the missing next chunk.",
		],
		parameters: appendSchema,
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Keep the queue locked until the in-flight filesystem operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				await ops.mkdir(dir);
				throwIfAborted();

				await ops.appendFile(absolutePath, content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully appended ${content.length} bytes to ${path}` }],
					details: undefined,
				};
			});
		},
	};
}

export function createAppendTool(cwd: string, options?: AppendToolOptions): AgentTool<typeof appendSchema> {
	return wrapToolDefinition(createAppendToolDefinition(cwd, options));
}
