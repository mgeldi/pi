import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

function getAgentHome() {
	return resolve(process.env.PI_AGENT_HOME ?? join(homedir(), ".pi", "agent"));
}

test("context-mode Pi bridge registers and executes ctx tools", async () => {
	const agentHome = getAgentHome();
	const packageRoot = join(agentHome, "npm", "node_modules", "context-mode");
	const bridgePath = join(packageRoot, "build", "adapters", "pi", "mcp-bridge.js");
	const serverBundle = join(packageRoot, "server.bundle.mjs");
	if (!existsSync(bridgePath) || !existsSync(serverBundle)) {
		throw new Error(`context-mode package is not installed under ${packageRoot}`);
	}

	const { bootstrapMCPTools } = await import(pathToFileURL(bridgePath).href);
	const registeredTools = [];
	const pi = {
		registerTool(tool) {
			registeredTools.push(tool);
		},
	};
	const handle = await bootstrapMCPTools(pi, serverBundle, {
		env: {
			...process.env,
			CONTEXT_MODE_DIR: process.env.CONTEXT_MODE_DIR ?? join(dirname(agentHome), "context-mode"),
			PI_CODING_AGENT_DIR: agentHome,
		},
	});
	try {
		const ctxExecute = registeredTools.find((tool) => tool.name === "ctx_execute");
		assert.ok(ctxExecute, `registered tools: ${registeredTools.map((tool) => tool.name).join(", ")}`);

		const result = await ctxExecute.execute("smoke-test", {
			language: "javascript",
			code: 'console.log("ok")',
		});

		assert.match(result.content?.[0]?.text ?? "", /ok/);
	} finally {
		handle.shutdown();
	}
});
