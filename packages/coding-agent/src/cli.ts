#!/usr/bin/env bun
// The module graph fails at link time on older runtimes, so it must load
// behind the dynamic import, after the dependency-free guard runs.
import { assertNodeVersion } from "./cli/node-version-check.js";

const isBun =
	!!process.versions.bun || typeof (globalThis as unknown as { Bun?: { version: string } }).Bun !== "undefined";
const runtimeVersion = isBun
	? ((globalThis as unknown as { Bun?: { version: string } }).Bun?.version ?? process.versions.bun ?? "0.0.0")
	: (process.versions.node ?? "0.0.0");

const supported = assertNodeVersion({
	version: runtimeVersion,
	log: console.error,
	exit: (code) => process.exit(code),
});

if (supported) {
	const { runCli } = await import("./cli-main.js");
	await runCli();
}
