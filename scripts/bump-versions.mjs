#!/usr/bin/env bun
/**
 * Bun-workspace version bump — replacement for `npm version -ws`.
 * Usage:
 *   bun scripts/bump-versions.mjs patch  # bump all workspaces
 *   bun scripts/bump-versions.mjs minor
 *   bun scripts/bump-versions.mjs major
 *   bun scripts/bump-versions.mjs 1.2.3  # set explicit version
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BUMP_TYPES = new Set(["patch", "minor", "major"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const target = process.argv[2];
if (!target || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) {
	console.error("Usage: bun scripts/bump-versions.mjs <patch|minor|major|x.y.z>");
	process.exit(1);
}

function bumpVersion(version, type) {
	const [major, minor, patch] = version.split(".").map(Number);
	if (type === "major") return `${major + 1}.0.0`;
	if (type === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function bumpOrSet(current, tgt) {
	if (BUMP_TYPES.has(tgt)) return bumpVersion(current, tgt);
	return tgt;
}

const packagesDir = join(process.cwd(), "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);

// Include root package.json as workspace
const workspacePaths = [join(process.cwd(), "package.json")];
for (const dir of packageDirs) {
	workspacePaths.push(join(packagesDir, dir, "package.json"));
}

let newVersion = null;
for (const pkgPath of workspacePaths) {
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		if (!pkg.version) continue;
		if (newVersion === null) {
			newVersion = bumpOrSet(pkg.version, target);
			console.log(`Bumping to ${newVersion} (from ${pkg.version})`);
		}
		if (pkg.version !== newVersion) {
			pkg.version = newVersion;
			writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
			console.log(`  updated ${pkgPath}: ${pkg.version}`);
		}
	} catch (e) {
		console.error(`Failed to process ${pkgPath}: ${e.message}`);
		process.exit(1);
	}
}

if (newVersion) {
	console.log(`\nAll workspaces at ${newVersion}`);
}
