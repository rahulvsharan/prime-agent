import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertNodeVersion, MIN_BUN_VERSION } from "../src/cli/node-version-check.js";

function run(version: string) {
	const logs: string[] = [];
	let exitCode: number | null = null;
	const ok = assertNodeVersion({
		version,
		log: (m) => logs.push(m),
		exit: (code) => {
			exitCode = code;
		},
	});
	return { ok, logs, exitCode };
}

describe("assertNodeVersion (bun-only)", () => {
	let originalBun: string | undefined;

	beforeEach(() => {
		// Ensure we are in "bun" mode for tests, even when vitest is run under Node
		originalBun = (process.versions as unknown as Record<string, string | undefined>).bun;
		(process.versions as unknown as Record<string, string | undefined>).bun = "1.4.0";
		// Also mock globalThis.Bun for completeness
		(globalThis as unknown as { Bun?: { version: string } }).Bun = { version: "1.4.0" };
	});

	afterEach(() => {
		if (originalBun === undefined) {
			delete (process.versions as unknown as Record<string, string | undefined>).bun;
			delete (globalThis as unknown as { Bun?: unknown }).Bun;
		} else {
			(process.versions as unknown as Record<string, string | undefined>).bun = originalBun;
		}
	});

	test("passes on the minimum supported version", () => {
		const { ok, logs, exitCode } = run(MIN_BUN_VERSION);
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
		expect(logs).toHaveLength(0);
	});

	test("passes on a newer minor", () => {
		const { ok, exitCode } = run("1.3.0");
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("passes on a newer patch", () => {
		const { ok, exitCode } = run("1.2.1");
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("passes on a newer major", () => {
		const { ok, exitCode } = run("2.0.0");
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("rejects a Bun release below the minimum", () => {
		const { ok, logs, exitCode } = run("1.1.9");
		expect(ok).toBe(false);
		expect(exitCode).toBe(1);
		expect(logs.join("\n")).toContain(`Bun ${MIN_BUN_VERSION}`);
	});

	test("rejects an outdated major with guidance and exit 1", () => {
		const { ok, logs, exitCode } = run("0.9.0");
		expect(ok).toBe(false);
		expect(exitCode).toBe(1);
		const text = logs.join("\n");
		expect(text).toContain(`Bun ${MIN_BUN_VERSION}`);
		expect(text).toContain("0.9.0");
		expect(text).toContain("github.com/PrimeIntellect-ai/prime-agent/releases/latest");
	});

	test("accepts the v prefix used by process.version", () => {
		const { ok, exitCode } = run(`v${MIN_BUN_VERSION}`);
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("accepts build metadata at the minimum version", () => {
		const { ok, exitCode } = run(`${MIN_BUN_VERSION}+build.1`);
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("rejects a prerelease of the minimum version", () => {
		const { ok, exitCode } = run(`${MIN_BUN_VERSION}-rc.1`);
		expect(ok).toBe(false);
		expect(exitCode).toBe(1);
	});

	test("lets an unparseable version through rather than blocking", () => {
		const { ok, exitCode } = run("not-a-version");
		expect(ok).toBe(true);
		expect(exitCode).toBeNull();
	});

	test("rejects when not running under Bun", () => {
		delete (process.versions as unknown as Record<string, string | undefined>).bun;
		delete (globalThis as unknown as { Bun?: unknown }).Bun;
		const { ok, logs, exitCode } = run("1.4.0");
		expect(ok).toBe(false);
		expect(exitCode).toBe(1);
		expect(logs.join("\n")).toContain("not Bun");
	});
});
