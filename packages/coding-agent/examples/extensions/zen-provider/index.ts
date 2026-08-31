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

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "zen";
const PROVIDER_NAME = "Zen (Local)";

const DEFAULT_BASE_URL = "http://localhost:3000/v1";

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

function toOpenAIMessages(context: Context): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	if (context.systemPrompt) out.push({ role: "system", content: context.systemPrompt });
	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") out.push({ role: "user", content: msg.content });
			else {
				const content = (
					msg.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
				).map((p) =>
					p.type === "text"
						? { type: "text", text: p.text }
						: { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } },
				);
				out.push({ role: "user", content });
			}
		} else if (msg.role === "assistant") {
			const text = (msg.content as Array<{ type: string; text?: string }>)
				.filter((b) => b.type === "text" && b.text?.trim())
				.map((b) => b.text)
				.join("");
			const toolCalls = (msg.content as Array<{ type: string; id?: string; name?: string; arguments?: unknown }>)
				.filter((b) => b.type === "toolCall")
				.map((b) => ({
					id: b.id,
					type: "function",
					function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) },
				}));
			const entry: Record<string, unknown> = { role: "assistant", content: text || null };
			if (toolCalls.length) entry.tool_calls = toolCalls;
			// skip empty assistant without tool_calls (aborted)
			if (!text && !toolCalls.length) continue;
			out.push(entry);
		} else if (msg.role === "toolResult") {
			const text = (msg.content as Array<{ type: string; text?: string }>)
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			out.push({ role: "tool", tool_call_id: (msg as { toolCallId: string }).toolCallId, content: text || "" });
		}
	}
	return out;
}

function streamZenLocal(
	model: Model<string>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as string,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			stream.push({ type: "start", partial: output });
			const messages = toOpenAIMessages(context);
			const body = JSON.stringify({
				model: model.id,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			});
			const res = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"Accept-Encoding": "identity",
					// Deliberately NO Authorization — local Zen bypass (opencode :3000) serves free models without auth
					// and fails with 401 if a dummy Bearer is sent (see curl laguna-s-2.1-free test)
				},
				body,
				signal: options?.signal,
			});
			if (!res.ok) {
				const t = await res.text().catch(() => "");
				throw new Error(`Zen local ${res.status} ${t.slice(0, 500)}`);
			}
			if (!res.body) throw new Error("No response body");
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			// text and tool-call block tracking (mirrors openai-completions)
			let textBlock: { type: "text"; text: string } | null = null;
			const toolBlocks = new Map<
				number,
				{
					type: "toolCall";
					id: string;
					name: string;
					arguments: Record<string, unknown>;
					partialArgs: string;
					streamIndex: number;
				}
			>();
			const toolById = new Map<string, typeof toolBlocks extends Map<number, infer V> ? V : never>();
			const blocks = output.content as Array<{
				type: string;
				text?: string;
				thinking?: string;
				id?: string;
				name?: string;
				arguments?: unknown;
				partialArgs?: string;
				streamIndex?: number;
			}>;
			const getIdx = (b: unknown) => blocks.indexOf(b as never);
			const ensureText = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock as never);
					stream.push({ type: "text_start", contentIndex: getIdx(textBlock), partial: output });
				}
				return textBlock;
			};
			const ensureTool = (delta: {
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}) => {
				const idx = typeof delta.index === "number" ? delta.index : undefined;
				let blk = idx !== undefined ? toolBlocks.get(idx) : undefined;
				if (!blk && delta.id) blk = toolById.get(delta.id);
				if (!blk) {
					blk = {
						type: "toolCall",
						id: delta.id || "",
						name: delta.function?.name || "",
						arguments: {},
						partialArgs: "",
						streamIndex: idx ?? -1,
					};
					if (idx !== undefined) toolBlocks.set(idx, blk);
					if (delta.id) toolById.set(delta.id, blk);
					blocks.push(blk as never);
					stream.push({ type: "toolcall_start", contentIndex: getIdx(blk), partial: output });
				}
				if (idx !== undefined && blk.streamIndex === -1) {
					blk.streamIndex = idx;
					toolBlocks.set(idx, blk);
				}
				if (delta.id) {
					blk.id = delta.id;
					toolById.set(delta.id, blk);
				}
				if (delta.function?.name) blk.name = delta.function.name;
				return blk;
			};
			let done = false;
			while (!done) {
				const { value, done: rDone } = await reader.read();
				if (rDone) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const line of lines) {
					const t = line.trim();
					if (!t || !t.startsWith("data:")) continue;
					const data = t.slice(5).trim();
					if (data === "[DONE]") {
						done = true;
						break;
					}
					let chunk: {
						id?: string;
						model?: string;
						usage?: { prompt_tokens?: number; completion_tokens?: number };
						choices?: Array<{
							finish_reason?: string;
							delta?: {
								content?: string;
								reasoning_content?: string;
								reasoning?: string;
								tool_calls?: Array<{
									index?: number;
									id?: string;
									function?: { name?: string; arguments?: string };
								}>;
							};
						}>;
					};
					try {
						chunk = JSON.parse(data);
					} catch {
						continue;
					}
					if (chunk.id) output.responseId ||= chunk.id;
					if (chunk.model && chunk.model !== model.id) output.responseModel ||= chunk.model;
					if (chunk.usage) {
						output.usage.input = chunk.usage.prompt_tokens || 0;
						output.usage.output = chunk.usage.completion_tokens || 0;
						output.usage.totalTokens = output.usage.input + output.usage.output;
						calculateCost(model as Model<string>, output.usage);
					}
					const choice = chunk.choices?.[0];
					if (!choice) continue;
					if (choice.finish_reason) {
						if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call")
							output.stopReason = "toolUse";
						else if (choice.finish_reason === "length") output.stopReason = "length";
						else if (choice.finish_reason === "stop" || choice.finish_reason === "end")
							output.stopReason = "stop";
						else output.stopReason = "stop";
					}
					const delta = choice.delta;
					if (!delta) continue;
					if (delta.content && delta.content.length) {
						const b = ensureText();
						b.text += delta.content;
						stream.push({ type: "text_delta", contentIndex: getIdx(b), delta: delta.content, partial: output });
					}
					const reasoning =
						(delta as { reasoning_content?: string; reasoning?: string }).reasoning_content ||
						(delta as { reasoning?: string }).reasoning;
					if (reasoning && reasoning.length) {
						// treat reasoning as text for free models without reasoning support
						const b = ensureText();
						b.text += reasoning;
						stream.push({ type: "text_delta", contentIndex: getIdx(b), delta: reasoning, partial: output });
					}
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const blk = ensureTool(tc);
							let d = "";
							if (tc.function?.arguments) {
								d = tc.function.arguments;
								blk.partialArgs += d;
								try {
									blk.arguments = JSON.parse(blk.partialArgs);
								} catch {
									// keep partial
								}
							}
							stream.push({ type: "toolcall_delta", contentIndex: getIdx(blk), delta: d, partial: output });
						}
					}
				}
			}
			// finalize blocks
			for (const b of [...blocks]) {
				const idx = getIdx(b);
				if (b.type === "text")
					stream.push({ type: "text_end", contentIndex: idx, content: b.text || "", partial: output });
				else if (b.type === "toolCall") {
					try {
						(b as { arguments: unknown; partialArgs: string }).arguments = JSON.parse(
							(b as { partialArgs: string }).partialArgs || "{}",
						);
					} catch {}
					delete (b as { partialArgs?: string }).partialArgs;
					delete (b as { streamIndex?: number }).streamIndex;
					stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: b as never, partial: output });
				}
			}
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (e) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = e instanceof Error ? e.message : String(e);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();
	return stream;
}

async function discoverModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	// Use identity encoding to avoid BrotliDecompressionError on some local gateways (e.g. opencode :3000)
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"Accept-Encoding": "identity",
	};
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
			streamSimple: streamZenLocal,
		});
		// Also route the built-in opencode provider through the same local bypass
		// so opencode/muse-spark-1.2-contributor-free (defaultModel) stops hitting
		// https://opencode.ai/zen/v1 with a stale cloud key and 401s.
		// Uses same no-auth streaming — local :3000 serves free models without Authorization.
		pi.registerProvider("opencode", {
			baseUrl,
			apiKey: apiKeyEnvName,
			api: "openai-completions",
			streamSimple: streamZenLocal,
		});
		// eslint-disable-next-line no-console
		console.log(
			`[zen-provider] registered ${models.length} model(s) from ${baseUrl} -> ${models.map((m) => m.id).join(", ")} (+ patched opencode -> ${baseUrl} no-auth)`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Fallback: register static models so provider is still usable offline / before zen is running
		// Include muse-spark so it appears even when discovery fails (offline)
		models = [
			{
				id: "muse-spark-1.2",
				name: "Muse Spark 1.2 (Zen Local)",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 16384,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
			{
				id: "muse-spark-1.2-contributor-free",
				name: "Muse Spark 1.2 Contributor Free (Zen Local)",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 16384,
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
				},
			},
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
		];
		pi.registerProvider(PROVIDER_ID, {
			name: PROVIDER_NAME,
			baseUrl,
			apiKey: apiKeyEnvName,
			api: "openai-completions",
			models,
			streamSimple: streamZenLocal,
		});
		// Also patch opencode provider in fallback path for the same 401 fix
		pi.registerProvider("opencode", {
			baseUrl,
			apiKey: apiKeyEnvName,
			api: "openai-completions",
			streamSimple: streamZenLocal,
		});
		// eslint-disable-next-line no-console
		console.warn(
			`[zen-provider] discovery failed for ${baseUrl}: ${message}. Registered fallback models: ${models.map((m) => m.id).join(", ")} (+ patched opencode)`,
		);
		// eslint-disable-next-line no-console
		console.warn(
			`[zen-provider] tip: set ZEN_BASE_URL=http://host:port/v1 and ensure GET ${baseUrl}/models is reachable`,
		);
	}
}
