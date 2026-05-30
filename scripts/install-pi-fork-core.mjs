#!/usr/bin/env node
import { access, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forkCliPath = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");

function defaultPiBinPath() {
	const prefix = process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix || (process.env.HOME ? join(process.env.HOME, ".npm-global") : undefined);
	if (!prefix) throw new Error("Could not determine the default pi bin path. Pass --bin <path>.");
	return join(prefix, "bin", "pi");
}

function parseArgs() {
	const args = process.argv.slice(2);
	let binPath;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			console.log(`Usage: node scripts/install-pi-fork-core.mjs [--bin <path>]

Installs the current checkout's built Pi CLI as the active pi executable.

The target defaults to "$NPM_CONFIG_PREFIX/bin/pi" or "~/.npm-global/bin/pi".
Run npm run build before this script so packages/coding-agent/dist/cli.js exists.`);
			process.exit(0);
		}
		if (arg === "--bin") {
			const value = args[++i];
			if (!value) throw new Error("--bin requires a path");
			binPath = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return { binPath };
}

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readSymlinkTarget(path) {
	try {
		const stat = await lstat(path);
		if (!stat.isSymbolicLink()) return undefined;
		return await readlink(path);
	} catch {
		return undefined;
	}
}

const { binPath } = parseArgs();
const piBinPath = resolve(binPath ?? defaultPiBinPath());
const backupPath = `${piBinPath}.upstream-npm`;

if (!(await pathExists(forkCliPath))) {
	throw new Error(`Fork CLI is not built: ${forkCliPath}\nRun npm run build first.`);
}

const existingTarget = await readSymlinkTarget(piBinPath);
const desiredTarget = relative(dirname(piBinPath), forkCliPath);

if (existingTarget !== undefined && resolve(dirname(piBinPath), existingTarget) === forkCliPath) {
	console.log(`pi already points to fork CLI: ${piBinPath} -> ${existingTarget}`);
	process.exit(0);
}

if ((await pathExists(piBinPath)) && !(await pathExists(backupPath))) {
	if (existingTarget !== undefined) {
		await symlink(existingTarget, backupPath);
		console.log(`Saved previous pi symlink: ${backupPath} -> ${existingTarget}`);
	} else {
		console.log(`Previous pi executable is not a symlink; no backup symlink created: ${piBinPath}`);
	}
}

if (await pathExists(piBinPath)) {
	await unlink(piBinPath);
}
await mkdir(dirname(piBinPath), { recursive: true });
await symlink(desiredTarget, piBinPath);

console.log(`Installed fork Pi CLI: ${piBinPath} -> ${desiredTarget}`);
