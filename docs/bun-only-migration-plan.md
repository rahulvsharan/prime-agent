# Bun-only Migration Plan — Remove Node.js Dependency

**Branch:** `chore/bun-only-migration` (from `main` @ 2026-08-30)  
**Author:** OpenCode / Muse Spark  
**Status:** Planning — no code changes yet  
**Goal:** Run, build, test, and distribute Prime Agent with **Bun only**. Remove the `Node.js` + `npm` runtime and package-manager dependency from development, CI, and user-facing install paths.

---

## 1. Goal and Scope

### Goal

Single runtime: `bun >= 1.2.0` (pin to latest stable `1.3.x` at time of merge). After migration:

* `bun install` replaces `npm ci` / `npm install`.
* `bun run <script>` replaces `npm run <script>` everywhere.
* `bun test` or `bunx vitest` replaces `node --test --import tsx` / `npx tsx`.
* `bun --version` + `bun pm` is the only required toolchain for contributors.
* CI, Husky, release scripts, and `install.sh` no longer invoke `node`/`npm`/`npx`.
* Distributed artifacts (tarball + Bun compiled binaries) remain unchanged, but are produced by Bun.

### Non-Goals

* No functional changes to agent, TUI, or provider behavior.
* No migration away from `vitest` → `bun:test` in this phase (keep vitest under Bun; evaluate later).
* No change to `prime-agent-runtime` Python side except how its JS host invokes tooling.
* No dropping `tsgo` (typescript-go) yet; Bun can type-check via `tsgo --noEmit` unchanged. Evaluate `bun tsc` later.

### Success Criteria

* `rm -rf node_modules bun.lockb? && bun install && bun run build && bun run check` passes clean on Linux/macOS with Bun only (Node not on PATH).
* CI green without `actions/setup-node`.
* `prime-agent.sh` runs via `bun` without `tsx`/`node` fallback.
* Fresh checkout + `curl .../install.sh | sh` works with `bun` present and without `node`/`npm`.

---

## 2. Current State Inventory

### 2.1 Package Manager and Workspace

| File | Current | Notes |
|---|---|---|
| `package.json:5` | `"workspaces": ["packages/*", ...]` | `npm` workspaces |
| `package.json:48-50` | `"engines": {"node": ">=22.8.0"}` | Root + each `packages/*/package.json:108` |
| `.npmrc:1-6` | `min-release-age=7` | npm supply-chain cooldown (Dependabot mirrors it) |
| `package-lock.json` | npm lockfile v3 | Must be replaced by `bun.lock` / `bun.lockb` |
| `packages/coding-agent/examples/*/package-lock.json` | 3 extra lockfiles (with-deps, custom-provider-*, sandbox) | Convert or delete |

`package.json:12-34` scripts use `npm run --workspaces`, `npm ci`, `npm publish -ws`, `shx`, `tsx`, `node scripts/...mjs`, `concurrently`.

### 2.2 Toolchain Binaries

| Invoker | Locations | Count |
|---|---|---|
| `node` / `npm` / `npx` | `package.json`, all `packages/*/package.json`, `.github/workflows/*.yml`, `scripts/*`, `.husky/pre-commit`, `test.sh`, `prime-agent.sh`, `install.sh`, `packages/coding-agent/src/config.ts`, `src/cli/node-version-check.ts` | ~60+ call sites |
| `tsx` | `packages/coding-agent/package.json:42-43` (`test:ci`, `test:process`), `packages/ai/package.json:67`, `prime-agent.sh:75-81`, `docs/development.md` | TS execution in dev/test |
| `tsgo` | `package.json:17`, `packages/*/package.json:dev` | Type checking — Bun-compatible (keep) |
| `esbuild` + `shx` + `concurrently` + `biome` | `package.json:36-46`, `packages/coding-agent/scripts/bundle.mjs` | Keep, but invoke via `bunx` / `bun run` |

### 2.3 CI

| File | Current |
|---|---|
| `.github/workflows/ci.yml:46-49,118-122` | `actions/setup-node@v7` with `node-version: 22` + `cache: npm` |
| `.github/workflows/ci.yml:58-64` | `npm ci` → `npm run build` → `npm run check`; matrix runs `npm test` |
| `.github/workflows/build-binaries.yml:45-49` | `actions/setup-node@v7` + `npm ci` |
| `.github/workflows/build-binaries.yml` (now named `Release Prime Agent`) | Also `npm ci`/`npm run build` + `node -p "require('./package.json').version"` |
| `.github/dependabot.yml:6-7` | `package-ecosystem: npm` |

### 2.4 Runtime Launch

* `prime-agent.sh:72` — `exec node "$BUNDLE"` for `--dist`; `prime-agent.sh:75-81` — `"$TSX_BIN" ".../cli.ts"` for dev (requires `tsx` via `node_modules/.bin/tsx`).
* `packages/coding-agent/src/cli.ts`, `src/cli-main.ts`, `src/main.ts` — entry points currently executed via `tsx` in dev, `node` in bundle.
* `packages/coding-agent/src/cli/node-version-check.ts:1-58` — Node version guard already skips when `process.versions.bun` is truthy, but still mentions Node semantics.
* `packages/coding-agent/src/config.ts:83-106` — `detectInstallMethod()` already detects `bun` / `bun-binary`; but self-update commands still emit `npm` instructions for most installs.

### 2.5 Scripts

| Script | Runtime |
|---|---|
| `scripts/sync-versions.js`, `release.mjs`, `pack-prime-agent-release.mjs`, `check-installer-render.mjs`, `check-browser-smoke.mjs`, `profile-coding-agent-node.mjs`, `bench-*.mjs`, `*.ts` | `node scripts/...` with `import { readFileSync } from "fs"` etc. — all Bun-runnable as-is (Bun supports `node:` imports + `node:fs`) |
| `scripts/build-binaries.sh` | Mixed: `npm ci`, `npm run build`, `npm install --no-save --force ...`, `bun build --compile` (already hybrid) |
| `packages/coding-agent/scripts/bundle.mjs` | `#!/usr/bin/env node` + esbuild `platform: "node"` — should become `bun` + `platform: "node"` still valid for Bun targets |
| `packages/coding-agent/postinstall.cjs` | `spawnSync(process.execPath, [script])` where `process.execPath` is Node; under Bun, `process.execPath` is Bun binary — must handle both |

### 2.6 Installer

`install.sh:853-922` (`run_preflight_checks`, `install_node_npm_interactive`, `detect_node_install_method`, `install_node_standalone`, etc.) — entire preflight / install flow is Node+npm centric. Downloads Node tarballs from `nodejs.org/dist/latest-v22.x`, verifies via `sha256sum`, installs to `~/.local/share/prime-agent-node`, mutates `PATH`, prompts to edit shell profile. After migration this block becomes Bun download/verify/install.

### 2.7 Docs

* `README.md:60` — `curl .../install.sh | sh` description mentions npm global install.
* `packages/coding-agent/docs/development.md:7-15` — requires `Node.js 22.8.0`, `npm ci`, `/prime-agent.sh`.
* `AGENTS.md:79-82,117-128` — commands reference `npm run check`, `npm install`, `min-release-age` guidance.
* `CONTRIBUTING.md:34` — changelog fragments via npm workspaces.

### 2.8 Native / Compiled Dependencies

| Package | Risk under Bun |
|---|---|
| `koffi@^2.9.0` (optional, TUI VT input on Windows) | Externalized in bundle builds; Bun compile marks `external: ["koffi"]`. Should continue to externalize. |
| `@silvia-odwyer/photon-node@^0.3.4` (wasm image) | WASM + native binding; verify `bun install` fetches correct `.wasm` artifact. |
| `@mariozechner/clipboard@^0.3.9` (optional, 6 platform bindings) | Cross-platform bindings fetched under Node via `npm ci --force`. Under Bun, `bun pm` needs equivalent cross-compile fetch. |
| `canvas@^3.2.0` (dev, `packages/ai`) | Requires `libcairo2-dev` etc. `bun install` builds via `node-gyp` shim — test on CI. |
| `undici@^7.29.0`, `proxy-agent`, `chalk`, `typebox`, `glob`, etc. | Pure JS — no risk. |
| `esbuild@^0.28.1`, `@biomejs/biome@2.5.5`, `shx`, `concurrently` | CLI tools invoked via `bunx` / `bun run`; verify no `npx` hard-coding. |

Bun already compiles the CLI via `bun build --compile` (`packages/coding-agent/package.json:37`, `scripts/build-binaries.sh:41-48`), so the binary path is pre-validated.

---

## 3. Target State

```
contributor machine:  bun >=1.3.14  (no node, no npm on PATH required)
package manager:      bun (bun.lock)
workspaces:           bun workspaces (package.json:workspaces stays, bun honors it)
typecheck:            tsgo --noEmit  (unchanged, invoked via bun)
lint/format:          biome check (via bunx / bun run)
test runner:          vitest via bunx (vitest detects bun runtime)
scripts:              bun scripts/*.mjs|*.ts   (shebang #!/usr/bin/env bun)
launcher:             prime-agent.sh  →  bun --bun run packages/coding-agent/src/cli.ts
installer:            checks/ installs bun, not node
CI:                   oven-sh/setup-bun@v2 + bun install + bun run build/check/test
lockfile:             bun.lock (text lockfile, Bun ≥1.2)  — delete package-lock.json
engines:              "bun": ">=1.2.0"  (keep "node" for npm registry compat or drop — decision below)
```

---

## 4. Detailed Change List (by area)

### 4.1 Package Manager — Root

**Files:** `package.json`, `.npmrc`, `package-lock.json` → `bun.lock`, all `packages/*/package.json`

* Replace `.npmrc` with `bunfig.toml` (Bun's `min-release-age` equivalent does not exist; use Dependabot cooldown only or document policy). Alternatively keep `.npmrc` for npm registry fallback but add `bunfig.toml` for install config.
* Root `package.json:5` workspaces: keep array as-is; Bun supports `workspaces` via same key. Verify `bun pm ls` enumerates all 4 workspaces + 3 example extensions.
* Replace `engines.node` with `engines.bun: ">=1.2.0"` (keep `engines.node` if publishing to npm registry requires it; npm warns but does not block on `bun` key. Decision: keep both during transition, remove `node` at release).
* `package.json:12-34` scripts — convert:

  ```json
  "clean": "bun run clean --filter='*'",
  "build": "bun --filter @earendil-works/pi-tui run build && bun --filter @earendil-works/pi-ai run build && ...",
  "dev": "concurrently ... \"bun --filter ... run dev\" ...",
  "check": "bunx biome check --write --error-on-warnings . && bunx tsgo --noEmit && bun run check:installer && bun run check:browser-smoke",
  "check:installer": "bun scripts/check-installer-render.mjs",
  "check:browser-smoke": "bun scripts/check-browser-smoke.mjs",
  "test": "bun run --filter='*' test",
  "version:patch": "bun pm version patch --no-git-tag-version ... && bun scripts/sync-versions.js && rm -rf node_modules ... && bun install",
  "release:pack": "bun scripts/pack-prime-agent-release.mjs",
  "release:patch": "bun scripts/release.mjs patch",
  ...
  "prepare": "husky"
  ```

  Explicit: replace `npm`/`npx` with `bun`/`bunx`, `npm ci` with `bun install --frozen-lockfile`, `npm publish -ws` with `bun pm pack` + publish logic, `npx tsx` with `bun`.
* Root `devDependencies`: keep `tsx` only if needed for non-Bun consumers; otherwise remove `tsx`, keep `typescript`, `shx`, `concurrently`, `husky`, `jiti`. `shx` remains (works under Bun). `@anthropic-ai/sandbox-runtime` etc. unchanged.
* Delete `package-lock.json`; commit `bun.lock` (text format).
* Example extensions with their own `package-lock.json`: delete lockfiles, or convert those sub-projects to Bun if they are installed standalone.

### 4.2 Package Manager — Workspaces

For each `packages/{ai,agent,tui,coding-agent}/package.json`:

* Replace `engines.node` with `engines.bun`.
* Convert scripts: `shx rm -rf dist` stays (shx is bun-compatible); `tsgo -p ...` stays (invoke via `bunx tsgo` or keep `tsgo` bin); `vitest --run` → `bunx vitest --run` or `bun run test` (vitest detects Bun runtime, uses `node:` compat).
* `postinstall: "node postinstall.cjs"` → `"bun postinstall.cjs"` or `"bun run postinstall.cjs"`. Update `postinstall.cjs` to handle `process.versions.bun` (see 4.5).
* `bundle: "node scripts/bundle.mjs"` → `"bun scripts/bundle.mjs"`.
* `generate-models: "npx tsx scripts/generate-models.ts"` → `"bun scripts/generate-models.ts"`.
* Verify `optionalDependencies` / `overrides` semantics: Bun supports `overrides` (npm-compatible) and `optionalDependencies`. Test `bun install` resolves `koffi`, `@mariozechner/clipboard` correctly.

### 4.3 TypeScript / Build Config

* `tsconfig.base.json:10` — `"module": "Node16"` / `"moduleResolution": "Node16"` — Bun supports `Node16`/`NodeNext`; keep. No change required. Optional future: `"module": "Preserve"` for Bun's native TS, but out of scope.
* `packages/*/tsconfig.build.json` — unchanged.
* `tsconfig.json:7-15` path aliases — unchanged (Bun respects `tsconfig.json` paths when running via `bun --bun`).

### 4.4 `prime-agent.sh` Launcher

**File:** `prime-agent.sh:65-81`

Current:
```bash
exec node "$BUNDLE" ...
TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
"$TSX_BIN" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ...
```

Target:
```bash
if [[ "$USE_DIST" == "true" ]]; then
  exec bun run "$BUNDLE" ...   # or exec "$BUNDLE" if compiled binary
fi
# dev: prefer bun, fallback error message mentions bun install
BUN_BIN="$(command -v bun)"
if [[ ! -x "$BUN_BIN" ]]; then echo "bun not found ..." >&2; exit 1; fi
exec bun --bun "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ...
```

* Remove `node` check; add `bun --version` check with minimum `1.2.0`.
* Keep `--dist` path but exec via `bun` if bundle is JS, or direct exec if compiled binary.
* Update `--no-env` handling unchanged.

### 4.5 Postinstall / Bootstrap

**Files:** `packages/coding-agent/postinstall.cjs`, `packages/coding-agent/src/core/kernel/bootstrap.ts`, `src/core/kernel/bootstrap-cli.ts`

* `postinstall.cjs:5-12` uses `spawnSync(process.execPath, [script])` where `process.execPath` is `node` or `bun`. Under Bun `process.execPath` is the `bun` binary — `spawnSync(bun, [dist/postinstall.js])` works because Bun can run JS. Ensure `dist/postinstall.js` uses `node:` imports (Bun compat OK). Update `postinstall.cjs` to `spawnSync(process.execPath, ...)` stays, but set `stdio: inherit` unchanged. Optionally rewrite as `postinstall.ts` run via `bun`.
* `scripts/setup-kernel-venv.sh` — shell script independent of Node; keep.

### 4.6 Scripts

All `scripts/*.mjs` and `*.ts` currently assume `node`. Bun runs them natively.

* Change shebang `#!/usr/bin/env node` → `#!/usr/bin/env bun` (Bun polyfills `node:` and `fs`, `child_process`, etc.).
* Replace any `execSync("npm ...")` / `spawn("npm", ...)` / `spawn("node", ...)` inside scripts with `bun` equivalents:
  * `scripts/sync-versions.js:32-48` — file IO only, no npm invocation, OK.
  * `scripts/release.mjs:55-79` (`run("npm run version:xxx")`, `run("git ...")`, `run("npm run publish")`) — replace `npm` with `bun` (`bun pm version`, `bun publish` or `npm publish` via bun's npm compat). Specifically `npm version patch -ws` → `bun pm version` is not workspace-aware; use `bun --filter` or keep `npm version` for registry publish step if npm registry still required (publishing with `npm publish` works under Bun's npm auth). Decision needed (see open questions).
  * `scripts/pack-prime-agent-release.mjs` — check for `npm` calls.
  * `scripts/check-installer-render.mjs`, `check-browser-smoke.mjs`, `profile-coding-agent-node.mjs` — audit and replace `node` invocations with `bun` (they spawn `node scripts/...` for smoke checks).
* `packages/coding-agent/scripts/bundle.mjs:1-52` — `import { build } from "esbuild"` with `platform: "node"` stays; shebang → `bun`; invocation via `bun scripts/bundle.mjs`.

### 4.7 Installer (`install.sh`)

**Scope:** Largest single-file change (~1620 lines). Replace Node-centric preflight + install.

* `run_preflight_checks:891-922` — replace `command -v node` + `node -e 'process.versions.node...'` check with `command -v bun` + `bun --version` and version gate `>=1.2.0`. Remove `npm` check. Update error strings ("Bun 1.2.0 or newer is required").
* `resolve_prime_agent_version` — keep (curl-based, no node).
* `install_node_npm_interactive:990-1018`, `detect_node_install_method:1020-1042`, `install_node_with_*` — replace with `install_bun_interactive`, `detect_bun_install_method` (homebrew → `brew install oven-sh/bun/bun`, apt/apk unsupported for Bun → fallback to `curl -fsSL https://bun.sh/install | bash`), or official `bun` install script.
* `install_node_standalone:1175-1227` — replace `https://nodejs.org/dist/latest-v22.x` + `SHASUMS256.txt` + `tar.xz` extract with `https://github.com/oven-sh/bun/releases/download/bun-v$VERSION/bun-$PLATFORM.zip` or `bun.sh` installer. Verify checksum via `sha256sum`.
* `load_standalone_node`, `node_standalone_base_dir`, `detect_node_binary_platform/arch` — rename to `bun` equivalents, base dir `~/.local/share/prime-agent-bun` or `~/.bun`.
* `configure_standalone_node_path` — update PATH handling for Bun's bin (`~/.bun/bin`).
* `install_prime_agent_package:1592-1618` — replace `npm install -g --no-fund --no-audit ... "$tarball_path"` with `bun install -g "$tarball_path"` (Bun global installs use `~/.bun/install/global`). Ensure `PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL` env still forwarded.
* Update `confirm_install` prompt text ("Install Prime Agent v$version globally with bun?").
* Keep R2 download/verify logic (`download_prime_agent_package`, `verify_prime_agent_package_checksum`) unchanged (uses `curl` + `sha256sum`).
* Ensure templating still replaces `__PRIME_AGENT_DOWNLOAD_BASE_URL__` / channel sentinels.

### 4.8 CI Workflows

**Files:** `.github/workflows/ci.yml`, `build-binaries.yml` (release), `nightly-process-stress.yml`

* `ci.yml:46-58` — replace:
  ```yaml
  - uses: actions/setup-node@v7
    with: { node-version: 22 }
  - run: npm ci
  - run: npm run build
  - run: npm run check   # which itself runs node scripts
  ```
  with:
  ```yaml
  - uses: oven-sh/setup-bun@v2
    with: { bun-version: latest }   # or pinned 1.3.14
  - run: bun install --frozen-lockfile
  - run: bun run build
  - run: bun run check
  ```
* Matrix `test` jobs: `command: npm test` → `bun test` or `bunx vitest --run`. For `packages/tui` currently `node --test --import tsx test/*.test.ts` → `bun test test/*.test.ts` or `bun --test` (need to migrate TUI tests from `node:test` to `bun:test` or keep `node:test` via Bun's `node:test` compat — Bun supports `node:test` so minimal change).
* `build-binaries.yml` — replace `setup-node` + `npm ci` with `setup-bun` + `bun install --frozen-lockfile` + `bun run build`. Keep `bun build --compile` steps (already Bun). The `node -p "require('./package.json').version"` → `bun -p "require('./package.json').version"` or `jq`.
* Add `bun pm ls` sanity check.
* Cache key: `cache: bun` is not a valid `setup-bun` option; use `actions/cache` for `~/.bun/install/cache` if needed.

### 4.9 Lint / Format / Hooks

* `biome.json:1-46` — unchanged (Biome is runtime-agnostic; invoke via `bunx biome`).
* `.husky/pre-commit:7` — `npm run check` → `bun run check`. Note Husky `prepare` script: `package.json:34` `"prepare": "husky"` runs on `bun install` as well (Husky supports Bun).
* `AGENTS.md` — update command references:
  *  `npm run check` → `bun run check`
  *  `npm install --min-release-age=0 <pkg>` → `bun add <pkg>` (no `min-release-age` equivalent)
  *  Release steps `npm run release:patch` → `bun run release:patch`

### 4.10 Runtime Helpers

* `packages/coding-agent/src/cli/node-version-check.ts:40-57` — rename to `runtime-version-check.ts` or keep but invert: check `process.versions.bun` first (already), else check `Bun.version` semver, warn if `<1.2.0`. Remove Node-only messaging. Update tests `test/node-version-check.test.ts` accordingly.
* `packages/coding-agent/src/utils/child-process.ts:8` — `WINDOWS_SHELL_COMMANDS` includes `npm`, `npx` — add `bun`, `bunx`. Remove `npm` if truly bun-only, but keep for compat if extensions shell out to npm.
* `packages/coding-agent/src/config.ts` (src/config.ts:45-203) — `InstallMethod` currently `"npm" | "bun" | ...` — after migration, default non-binary install reports `"bun"`; keep `"npm"` variant for backward compat with existing global installs (users who installed via `npm -g` before migration). Update `getSelfUpdateCommandForMethod` so `npm` path still works for legacy installs, but `detectInstallMethod` prefers Bun. Add warning/log when `npm` install detected after migration.
* `packages/coding-agent/src/package-manager-cli.ts` — audit for `npm` hard-coding.

### 4.11 Configuration Files

* `.npmrc` — Bun ignores `.npmrc` `min-release-age`. Create `bunfig.toml`:
  ```toml
  [install]
  frozenLockfile = true
  # no min-release-age equivalent; supply-chain policy moves to Dependabot cooldown + manual audit
  ```
  Keep `.npmrc` for users who still `npm install` during transition, or delete per "bun-only" strictness.
* `.github/dependabot.yml` — change `package-ecosystem: npm` → `package-ecosystem: bun` (Dependabot supports `bun`; GitHub docs list `bun` as ecosystem). Keep npm entry for a transition period if both lockfiles exist.
* `prime-agent-runtime/pyproject.toml` / `uv` — unrelated.

### 4.12 Docs

* `README.md`, `packages/coding-agent/docs/development.md`, `packages/coding-agent/docs/quickstart.md`, `CONTRIBUTING.md`, `AGENTS.md` — replace all `Node.js` / `npm` prerequisites with `Bun`. Include install line: `curl -fsSL https://bun.sh/install | bash` + `bun --version`.
* Add migration note for contributors with existing `node_modules`: `rm -rf node_modules package-lock.json && bun install`.

---

## 5. Phased Execution Plan

### Phase 0 — Preparation (this document, no code)

* This plan on `chore/bun-only-migration`. Review & approvals.
* Decide open questions in §8. Land branch protection so `main` stays npm until cutover.

### Phase 1 — Dual-support (npm + bun) — low-risk mechanical changes

Goal: `bun install` works alongside `npm ci` before removing Node.

1. Add `bunfig.toml`, keep `.npmrc`.
2. Add `bun.lock` (generated via `bun install`) alongside `package-lock.json`; update `.gitignore` if needed.
3. Update `package.json` scripts to be manager-agnostic where possible (use `bun --bun` wrappers that still work via `npx` fallback, or keep npm scripts but add `bun` equivalents).
4. Migrate `scripts/*.mjs` shebangs to `#!/usr/bin/env bun` (Bun can still be invoked via `node` compat if node present).
5. Update `prime-agent.sh` to try `bun` first, fall back to `node`/`tsx` (branch logic, not breaking).
6. CI: add a parallel `bun` job (`oven-sh/setup-bun`) that runs `bun install && bun run build && bun run check` without removing Node jobs.
7. Verify `bun run test` parity: compare `npm test` vs `bunx vitest --run` outputs.

Exit criteria: both `npm ci && npm run check` and `bun install && bun run check` green on same commit.

### Phase 2 — Cutover (remove Node)

Goal: delete Node paths, make Bun the sole runtime.

1. Replace `.github/workflows/ci.yml` setup-node matrix with setup-bun.
2. Update `prime-agent.sh` to remove Node/tsx fallback (error if `bun` missing, suggest `curl -fsSL https://bun.sh/install | bash`).
3. Delete `package-lock.json`, keep `bun.lock`.
4. Remove `tsx` from `devDependencies` where no longer needed; delete example `package-lock.json`.
5. Update `.npmrc` → `bunfig.toml` (delete `.npmrc` or keep for npm publish compat).
6. Update `.github/dependabot.yml` ecosystem to `bun`.
7. Rewrite `install.sh` Node blocks → Bun blocks (largest diff; see §4.7).
8. Rename `src/cli/node-version-check.ts` → `runtime-version-check.ts` and update tests.
9. Update all `package.json` `engines` and scripts per §4.1-4.2.
10. Update docs (`README.md`, `development.md`, `AGENTS.md`, `CONTRIBUTING.md`).

Exit criteria: repo fresh-clone with only Bun on PATH passes `bun install && bun run build && bun run check && bun run test` and `prime-agent.sh` launches.

### Phase 3 — Publish & Distribution

1. Verify `bun pm pack` / `npm publish` still works for registry distribution (Bun can publish to npm registry via `bun publish` or `npm publish` with `NPM_TOKEN`). Decide registry auth flow.
2. Update `scripts/release.mjs` and `scripts/pack-prime-agent-release.mjs` to use `bun` where safe; keep `npm publish` for registry if `bun publish` not desired.
3. Produce and verify R2 release artifacts (`prime-agent-<version>.tgz`, `SHA256SUMS`, `stable`/`beta` pointers) via `bun run release:pack`.
4. Verify `scripts/build-binaries.sh` cross-compile produces identical archives (compare `tar -tzf` listings vs main).
5. Test `install.sh` against staging R2 bucket with Bun-only host (Docker image `oven/bun:1.3` plus no Node).

### Phase 4 — Cleanup & Hardening

1. Remove legacy `npm` code paths in `src/config.ts` self-update if desired (keep for one release to support `npm -g` upgraders).
2. Add CI guard: `if command -v node >/dev/null && node --version; then echo "node found but not required"; fi` — or fail if `node` invoked in scripts (grep CI logs).
3. Update `test.sh` (`npm test` → `bun test`).
4. Audit remaining `grep -R "npm"` hits; file follow-ups or `no-npm` lint rule.
5. Publish migration guide for contributors (`docs/bun-only-migration-plan.md` → `docs/migration-from-npm.md`).

---

## 6. Risk Register and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `koffi` / `photon-node` / `canvas` native bindings fail under `bun install` | Build broken on Linux CI | Phase 1 dual CI catches early; pin known-good versions; add `postinstall` script test. Fallback: keep `npm ci` for native binding fetch during transition. |
| `tsx` removal breaks `vitest` TS transform | Tests fail | Vitest under Bun uses its own transform; verify `vitest --run` via `bunx`. Keep `tsx` as devDependency during Phase 1. |
| `package-manager` detection (`src/config.ts`) mis-identifies Bun global installs | Self-update commands wrong | Add explicit test matrix for `detectInstallMethod` under Bun global path (`~/.bun/install/global/node_modules`) — already partially covered in `test/config.test.ts:128-137`. Extend tests. |
| `install.sh` Bun download URL / checksum mismatch per arch | New users cannot install | Add `install.sh` smoke matrix in CI: run installer with `PRIME_AGENT_INSTALLER_PLAIN=1` in Docker images per platform (linux-x64, linux-arm64, darwin). |
| `bun.lock` text lockfile churn vs `package-lock.json` binary | Large diff noise, merge conflicts | Commit `bun.lock` once at cutover; enforce `bun install --frozen-lockfile` in CI to prevent drift. Document `bun install` regenerates deterministically. |
| `esbuild` `platform: node` bundle incompatible with Bun's `node:` compat | Runtime crash | `bundle.mjs` already externalizes native modules; keep `platform: node`, test bundle via `node dist/bundle/cli.js` and `bun dist/bundle/cli.js`. |
| Dependabot `bun` ecosystem lag vs `npm` | Security updates delayed | Keep `package-ecosystem: npm` for one cycle after cutover if Dependabot bun support incomplete; monitor. |
| Contributors without Bun | Onboarding friction | Provide `curl -fsSL https://bun.sh/install | bash` one-liner in `README.md` and `AGENTS.md`; add `bun --version` check with friendly error in `prime-agent.sh:72-81`. |

---

## 7. Verification Matrix

| Check | Command (Bun-only) | Expected |
|---|---|---|
| Install | `rm -rf node_modules && bun install --frozen-lockfile` | No errors, `bun.lock` unchanged, `node_modules/.bin/tsgo` present |
| Build | `bun run build` | All 4 workspaces emit `dist/` (`tui`, `ai`, `agent`, `coding-agent`) + `dist/bundle/` |
| Check | `bun run check` | `biome check` clean, `tsgo --noEmit` 0, `check-installer-render.mjs` + `browser-smoke` pass |
| Unit tests | `bunx vitest --run` per workspace or `bun run test` | `packages/{ai,agent,tui,coding-agent}` all green; `test.sh` with `PI_NO_LOCAL_LLM=1` |
| TUI tests | `bun --filter @earendil-works/pi-tui run test` | `node:test` suites pass under Bun's `node:test` compat |
| Launcher (dev) | `bun prime-agent.sh --help` | Prints help without `tsx not found` |
| Launcher (dist) | `bun run build && bun prime-agent.sh --dist --help` | Runs bundled CLI |
| Binary | `scripts/build-binaries.sh --skip-deps --platform linux-x64` | `binaries/linux-x64/pi` runs `--help` |
| Installer | `PRIME_AGENT_INSTALLER_PLAIN=1 sh install.sh -- --version 0.8.1` in `oven/bun:1.3-slim` container without Node | Preflight passes with `bun --version`, downloads & verifies tarball |
| No npm leakage | `grep -R "npm " --include="*.json" --include="*.yml" --include="*.sh" \| grep -v "npm:"` | Only intentional hits (e.g., `npm:` skill spec, changelog) |

---

## 8. Open Questions — Decisions Before Phase 2

1. **Publish path:** Keep `npm publish -ws --access public` (works with `NPM_TOKEN` even when built with Bun) or migrate to `bun publish`? `bun publish` speaks npm registry protocol but npm provenance and 2FA behavior may differ. **Recommendation:** Keep `npm publish` for registry, invoke via `bunx npm publish` or `npm` shim if `npm` not on PATH (Bun ships `bun pm pack` + `npm` compat). Needs spike.

2. **`engines` field:** Drop `engines.node` entirely (strict bun-only, `npm install` will warn) or keep `node >=20` alongside `bun >=1.2` for npm-registry consumers who haven't migrated? **Recommendation:** Keep both for one minor release, remove `node` at next minor.

3. **Lockfile:** Use `bun.lock` (text, new) or `bun.lockb` (binary, legacy)? Bun 1.2+ defaults to `bun.lock` text format. **Recommendation:** `bun.lock` text.

4. **`tsx` retention:** Remove `tsx` now or keep for `vitest` / `jiti` extension loading? `jiti` is used for extension loading inside bundle (`__PI_BUNDLED__`). **Recommendation:** Remove top-level `tsx` in Phase 2, keep `jiti`.

5. **`concurrently` vs `bun --parallel`:** Bun has `bun --filter '*' --parallel run dev`. Keep `concurrently` for colored prefix or replace? **Recommendation:** Keep `concurrently` initially (low risk), replace later if desired.

6. **Minimum Bun version:** `1.2.0` (current LTS) or `1.3.14` (latest tested)? **Recommendation:** `>=1.2.0` in `engines`, but CI pins `1.3.x` latest.

7. **Example extensions with `package-lock.json`:** Convert those sub-projects to Bun or keep them as npm examples for users? **Recommendation:** Convert to Bun for consistency; document that `npm:` skill spec string is domain language, not npm dependency.

---

## 9. File-Level Change Checklist

- [ ] `package.json` — scripts, engines, devDependencies, prepare, version:* scripts
- [ ] `packages/ai/package.json`, `packages/agent/package.json`, `packages/tui/package.json`, `packages/coding-agent/package.json` — engines, scripts
- [ ] `.npmrc` → `bunfig.toml` (+ decision on keeping .npmrc)
- [ ] `package-lock.json` → `bun.lock`
- [ ] `packages/coding-agent/examples/*/package-lock.json` — delete or convert
- [ ] `tsconfig.base.json` / `tsconfig.json` — no change (verify)
- [ ] `prime-agent.sh` — bun-first launcher
- [ ] `packages/coding-agent/scripts/bundle.mjs` — shebang + bun invocation
- [ ] `scripts/sync-versions.js`, `scripts/release.mjs`, `scripts/pack-prime-agent-release.mjs`, `scripts/check-*.mjs`, `scripts/build-binaries.sh`, `scripts/profile-coding-agent-node.mjs` — bun-ify
- [ ] `install.sh` — replace Node install blocks (≈600 lines) with Bun equivalents
- [ ] `test.sh` — `npm test` → `bun test`
- [ ] `.husky/pre-commit` — `npm run check` → `bun run check`
- [ ] `.github/workflows/ci.yml`, `build-binaries.yml`, `nightly-process-stress.yml` — setup-bun
- [ ] `.github/dependabot.yml` — npm → bun ecosystem
- [ ] `packages/coding-agent/src/cli/node-version-check.ts` → runtime check
- [ ] `packages/coding-agent/src/config.ts` — InstallMethod / self-update / getPackageDir
- [ ] `packages/coding-agent/postinstall.cjs` — bun execPath handling
- [ ] `README.md`, `packages/coding-agent/docs/development.md`, `AGENTS.md`, `CONTRIBUTING.md` — prerequisites
- [ ] `biome.json` — no change
- [ ] `test/node-version-check.test.ts`, `test/config.test.ts`, `test/package-manager.test.ts` — update expectations

---

## 10. Rollback Plan

* Branch `chore/bun-only-migration` stays rebased on `main` until merge. If Phase 2 cutover causes breakage, revert merge commit or reset to pre-cutover tag; `package-lock.json` remains in Git history. `bun.lock` deletion restores npm path.
* CI keeps a `main-npm` tag for hotfix branch if needed.
* Installer R2 artifacts are immutable per version prefix (`releases/vX.Y.Z/`); Bun-only installer does not overwrite npm-era installers for same version (new version required).

---

## 11. References

* Current Bun version on runner: `bun 1.3.14` / `node 24.19.0` / `npm 11.17.0` (verified 2026-08-30).
* Existing Bun usage in repo: `packages/coding-agent/package.json:37` (`bun build --compile`), `scripts/build-binaries.sh:35-48`, `src/config.ts:32-36` (`isBunBinary`/`isBunRuntime`), `src/bun/restore-sandbox-env.ts` (Bun sandbox workaround).
* npm supply-chain policy: `AGENTS.md:79-82`, `.npmrc:1-6`, `.github/dependabot.yml:10-12` (`cooldown: 7` days, `min-release-age=7`).

---

## 12. Next Steps (after plan approval)

1. Get approval on §8 decisions.
2. Create GitHub issue tracking this migration (labels `pkg:ai`, `pkg:coding-agent`, `pkg:agent`, `pkg:tui`).
3. Begin Phase 1 PRs (dual-support) — one PR per area to keep review small (e.g., scripts + launcher, then CI, then workspaces).
4. Phase 2 cutover PR deletes Node paths and `package-lock.json`, lands `bun.lock`.
