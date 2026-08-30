// Dependency-free and Bun-safe so it can never crash on the versions it rejects.

const MIN_BUN_VERSION_PARTS = [1, 2, 0] as const;
export const MIN_BUN_VERSION = MIN_BUN_VERSION_PARTS.join(".");
// Keep for backward compat; new code should use MIN_BUN_VERSION
export const MIN_NODE_VERSION = "22.8.0";

export interface NodeVersionGuardIO {
	version: string;
	log: (message: string) => void;
	exit: (code: number) => void;
}

interface ParsedVersion {
	parts: readonly [number, number, number];
	prerelease: boolean;
}

function parseVersion(version: string): ParsedVersion | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) {
		return undefined;
	}

	return {
		parts: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] !== undefined,
	};
}

function isSupportedVersion(version: ParsedVersion, minParts: readonly number[]): boolean {
	for (let index = 0; index < minParts.length; index++) {
		const part = version.parts[index]!;
		const minimumPart = minParts[index]!;
		if (part !== minimumPart) {
			return part > minimumPart;
		}
	}
	return !version.prerelease;
}

export function assertNodeVersion(io: NodeVersionGuardIO): boolean {
	const isBun =
		!!process.versions.bun || typeof (globalThis as unknown as { Bun?: { version: string } }).Bun !== "undefined";
	if (isBun) {
		const bunVersionStr = io.version;
		const version = parseVersion(bunVersionStr);
		if (!version || isSupportedVersion(version, MIN_BUN_VERSION_PARTS)) {
			return true;
		}
		io.log(`prime-agent requires Bun ${MIN_BUN_VERSION} or newer, but the active Bun is v${bunVersionStr}.`);
		io.log("");
		io.log(
			`  1. Install Bun ${MIN_BUN_VERSION}+ (e.g. "curl -fsSL https://bun.sh/install | bash" or from https://bun.sh)`,
		);
		io.log("  2. Reinstall prime-agent under that Bun so the command resolves to it:");
		io.log("     https://github.com/PrimeIntellect-ai/prime-agent/releases/latest");
		io.exit(1);
		return false;
	}

	// Not running under Bun — Bun is required
	io.log(`prime-agent requires Bun ${MIN_BUN_VERSION} or newer, but the active runtime is v${io.version} (not Bun).`);
	io.log("");
	io.log(
		`  1. Install Bun ${MIN_BUN_VERSION}+ (e.g. "curl -fsSL https://bun.sh/install | bash" or from https://bun.sh)`,
	);
	io.log("  2. Reinstall prime-agent under that Bun so the command resolves to it:");
	io.log("     https://github.com/PrimeIntellect-ai/prime-agent/releases/latest");
	io.exit(1);
	return false;
}

// Alias for new naming
export const MIN_VERSION = MIN_BUN_VERSION;
export const assertBunVersion = assertNodeVersion;
