# Zen Local Provider

Env-driven OpenAI-compatible provider for your local Zen bypass service.

## How it works

Registers provider `zen` via `pi.registerProvider` (`docs/custom-provider.md:30`). Reads `baseUrl` at startup from env — no code change when you move the service.

**Env vars (first match wins):**

| Purpose | Vars (priority order) |
|---|---|
| Base URL | `ZEN_BASE_URL` > `ZEN_API_BASE_URL` > `ZEN_API_URL` > `OPENCODE_ZEN_BASE_URL` > `ZEN_URL` |
| API key | `ZEN_API_KEY` > `OPENCODE_API_KEY` > `OPENCODE_ZEN_API_KEY` |

If `ZEN_BASE_URL` is unset, defaults to `http://localhost:4096/v1` (change `DEFAULT_BASE_URL` in `index.ts:12`).

Local bypasses often ignore the key — a dummy is injected so `/model` availability passes.

## Model discovery

On startup tries `GET {baseUrl}/models` (4s timeout). If reachable, all returned models are registered (`openai-completions`, `compat.supportsDeveloperRole=false`). If unreachable, registers fallback `zen-free` / `zen-think` so the provider still appears.

## Usage

```bash
# 1. Start your zen service (example: port 4096)
#    Ensure GET http://localhost:4096/v1/models returns {"data":[{"id":"..."}]}

# 2. Run with env-driven URL — ad-hoc
ZEN_BASE_URL=http://localhost:4096/v1 prime-agent -e ./packages/coding-agent/examples/extensions/zen-provider

# 3. Or install to auto-discovered location (then /reload works)
mkdir -p ~/.prime/agent/extensions
cp -r packages/coding-agent/examples/extensions/zen-provider ~/.prime/agent/extensions/zen-provider
ZEN_BASE_URL=http://localhost:4096/v1 prime-agent

# 4. Verify
ZEN_BASE_URL=http://localhost:4096/v1 prime-agent model list | grep zen
ZEN_BASE_URL=http://localhost:4096/v1 prime-agent --provider zen --model zen-free -p "hello"

# 5. Switch service without editing code
ZEN_BASE_URL=http://192.168.1.50:3000/v1 prime-agent --provider zen --model zen-free -p "hello"
ZEN_API_KEY=sk-real ZEN_BASE_URL=https://zen.example.com/v1 prime-agent --provider zen --model zen-free -p "hello"
```

## When to change `api`

Default is `openai-completions` (covers OpenCode/Zen/Ollama/vLLM). If your bypass emulates Anthropic `POST /v1/messages`, change `api: "anthropic-messages"` in `index.ts:105`.

## Troubleshooting

- `discovery failed` warning: check `curl $ZEN_BASE_URL/models | jq` and firewall; fallback models still work for `zen-free`.
- Auth 401: set `ZEN_API_KEY` to the token your bypass expects (or dummy if none).
- `/model` empty: ensure `ZEN_BASE_URL` ends with `/v1` and the extension path is passed via `-e` or copied to `~/.prime/agent/extensions/`.
