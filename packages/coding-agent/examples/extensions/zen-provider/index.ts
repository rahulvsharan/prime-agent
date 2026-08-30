/**
 * Zen Local Provider — OpenAI-compatible free LLM via local bypass
 *
 * Registers a `zen` provider that reads its endpoint from an environment
 * variable so you can switch URLs without editing code:
 *
 *   ZEN_BASE_URL=http://localhost:4096/v1 prime-agent
 *   ZEN_BASE_URL=http://localhost:8080/v1 prime-agent --provider zen --model zen-free
 *   ZEN_BASE_URL=http://192.168.1.50:3000/v1 prime-agent -e ./packages/coding-agent/examples/extensions/zen-provider
 *
 * Supported env vars (first match wins):
 *   - ZEN_BASE_URL
 *   - ZEN_API_BASE_URL
 *   - ZEN_API_URL
 *   - OPENCODE_ZEN_BASE_URL
 *   - ZEN_URL
 *
 * API key resolution (first match wins):
 *   - ZEN_API_KEY
 *   - OPENCODE_API_KEY
 *   - OPENCODE_ZEN_API_KEY
 *   - dummy fallback (local bypass usually ignores auth)
 *
 * Models are discovered dynamically via GET {baseUrl}/models.
 * If discovery fails, a static fallback list is registered so /model still works.
 *
 * API: openai-completions (most OpenCode/Zen proxies are OpenAI-compatible).
 * Change to "anthropic-messages" if your bypass emulates Claude messages.
 *
 * Usage:
 *   prime-agent -e ./packages/coding-agent/examples/extensions/zen-provider
 *   # or copy to auto-discovered location:
 *   cp -r packages/coding-agent/examples/extensions/zen-provider ~/.prime/agent/extensions/zen-provider
 *   # then hot-reload with /reload, or just restart prime-agent
 *
 * Test:
 *   ZEN_BASE_URL=http://localhost:4096/v1 prime-agent model list | grep zen
 *   ZEN_BASE_URL=http://localhost:4096/v1 prime-agent --provider zen --model zen-free -p "hello"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "zen";
const PROVIDER_NAME = "Zen (Local)";

const DEFAULT_BASE_URL = "http://localhost:4096/v1";

// Env vars checked in order for baseUrl
const BASE_URL_ENV_VARS = [
	"ZEN_BASE_URL",
	"ZEN_API_BASE_URL",
	"ZEN_API_URL",
	"OPENCODE_ZEN_BASE_URL",
	"ZEN_URL",
	"OPENCODE_BASE_URL",
] as const;

// Env vars checked for apiKey
const API_KEY_ENV_VARS = ["ZEN_API_KEY", "OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"] as const;

function resolveEnvValue(names: readonly string[]): string | undefined {
	for (const name of names) {
		const v = process.env[name];
		if (v && v.trim()) return v.trim();
	}
	return undefined;
}

function normalizeBaseUrl(raw: string): string {
	const url = raw.trim().replace(/\/+$/, "");
	// If user passed bare host without /v1, keep as-is; providers require full baseUrl.
	// Common mistake: http://localhost:4096 -> should be http://localhost:4096/v1
	return url;
}

function resolveBaseUrl(): string {
	const fromEnv = resolveEnvValue(BASE_URL_ENV_VARS);
	if (fromEnv) return normalizeBaseUrl(fromEnv);
	return DEFAULT_BASE_URL;
}

function resolveApiKeyEnvName(): string {
	const fromEnv = resolveEnvValue(API_KEY_ENV_VARS);
	if (fromEnv) {
		// If the env value itself is a literal key (starts with sk-), return dummy env name;
		// pi.registerProvider will use the env var name, not the value.
		// Prefer returning the var name that is set, so the provider reads it at request time.
		for (const name of API_KEY_ENV_VARS) {
			if (process.env[name]?.trim()) return name;
		}
	}
	// prefer ZEN_API_KEY if none set, otherwise fallback to OPENCODE_API_KEY
	if (process.env.ZEN_API_KEY) return "ZEN_API_KEY";
	if (process.env.OPENCODE_API_KEY) return "OPENCODE_API_KEY";
	return "ZEN_API_KEY";
}

type DiscoveredModel = {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	contextWindow?: number;
	maxTokens?: number;
};

async function discoverModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	// Local bypasses often ignore auth, but send header if we have a non-dummy key
	if (apiKey && apiKey !== "zen-local-dummy" && !apiKey.startsWith("!")) {
		// If apiKey looks like an env var name, resolve it; otherwise use directly
		const resolved = process.env[apiKey] ?? apiKey;
		if (resolved && resolved !== apiKey) headers.Authorization = `Bearer ${resolved}`;
		else if (resolved && resolved.length > 0) headers.Authorization = `Bearer ${resolved}`;
	}

	const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
	const payload = (await res.json()) as { data?: DiscoveredModel[]; models?: DiscoveredModel[] } | DiscoveredModel[];
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload.data)) return payload.data;
	if (Array.isArray(payload.models)) return payload.models;
	throw new Error(`Unexpected /models shape from ${url}: ${JSON.stringify(payload).slice(0, 500)}`);
}

export default async function (pi: ExtensionAPI) {
	const baseUrl = resolveBaseUrl();
	const apiKeyEnvName = resolveApiKeyEnvName();

	// Ensure the env var exists so /model availability checks pass; local bypasses ignore it.
	if (!process.env[apiKeyEnvName]) {
		process.env[apiKeyEnvName] = "zen-local-dummy";
	}

	let models: Array<{
		id: string;
		name: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		compat?: Record<string, unknown>;
	}>;

	try {
		const discovered = await discoverModels(baseUrl, apiKeyEnvName);
		if (discovered.length === 0) throw new Error("No models returned from discovery");

		models = discovered.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.context_window ?? m.contextWindow ?? 128000,
			maxTokens: m.max_tokens ?? m.maxTokens ?? 8192,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
		}));
		pi.registerProvider(PROVIDER_ID, {
			name: PROVIDER_NAME,
			baseUrl,
			apiKey: apiKeyEnvName,
			api: "openai-completions",
			models,
		});
		// eslint-disable-next-line no-console
		console.log(
			`[zen-provider] registered ${models.length} model(s) from ${baseUrl} -> ${models.map((m) => m.id).join(", ")}`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Fallback: register static models so provider is still usable offline / before zen is running
		models = [
			{
				id: "zen-free",
				name: "Zen Free (local fallback)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
			{
				id: "zen-think",
				name: "Zen Think (local fallback)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 16384,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
		];
		pi.registerProvider(PROVIDER_ID, {
			name: PROVIDER_NAME,
			baseUrl,
			apiKey: apiKeyEnvName,
			api: "openai-completions",
			models,
		});
		// eslint-disable-next-line no-console
		console.warn(
			`[zen-provider] discovery failed for ${baseUrl}: ${message}. Registered fallback models: ${models.map((m) => m.id).join(", ")}`,
		);
		// eslint-disable-next-line no-console
		console.warn(
			`[zen-provider] tip: set ZEN_BASE_URL=http://host:port/v1 and ensure GET ${baseUrl}/models is reachable`,
		);
	}
}
