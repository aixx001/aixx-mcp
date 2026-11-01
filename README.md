# @ AIXX MCP Server

> **Google for AI — One line. Every AI model.**
> A zero-dependency MCP server that lets any MCP-compatible client (WorkBuddy, Claude Desktop, Cursor, etc.) call **dozens of LLMs + image/video generation** through a single AIXX key.

**AIXX** is built by [Wanan Exchange (AIXX)](https://www.aixx.vip) — the world's first verification-first compute exchange: every GPU listed has passed on-site physical inspection with a traceable, numbered report. Ecosystem: [Compute Market](https://www.aixx.vip/static/market/index.html) · [Hardware Wiki](https://aixx.ai/wiki/) · [AIXX Cloud](https://aixx.ai/cloud.html) · [AI News](https://aixx.ai/news.html).

## What it does

- 🔑 **One key, every model** — Claude, GPT, Gemini, DeepSeek, Qwen, GLM, Moonshot, MiniMax and more (38+ text models, live list).
- 🖼️ **Image generation** — GPT-Image-2, Nano Banana Pro, Seedream, Midjourney, ...
- 🎬 **Video generation** — MiniMax H3, Veo 3.1, Kling, Seedance, ... (async + task polling).
- 🔌 **OpenAI-compatible** — talks to `https://baodan.run/v1`.
- 🪶 **Zero dependencies** — single file, Node 18+ only.

## Get a key

Register at **https://baodan.run/console/** — new accounts get **¥5 free credit**. After login, generate your `sk-` key on the **令牌 (Tokens)** page.

Your key looks like `sk-` + 16-128 alphanumeric characters.

## Configure

Set your key via the `AIXX_API_KEY` environment variable (recommended), or pass `apiKey` per call.

### WorkBuddy

Add to `~/.workbuddy/mcp.json`:

```json
{
  "mcpServers": {
    "aixx": {
      "command": "npx",
      "args": ["-y", "aixx-mcp"],
      "env": {
        "AIXX_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### Claude Desktop / Cursor

Same block under `mcpServers` in your client's MCP config.

## Tools

| Tool | Description |
|------|-------------|
| `aixx_list_models` | List live text models (cached 5 min). |
| `aixx_chat` | Chat completion. Supports streaming internally, returns full text. |
| `aixx_image` | Generate an image (sync ≤90s, then falls back to task). |
| `aixx_video` | Submit a video generation task (async). |
| `aixx_task` | Poll an image/video task for status/result URL. |

### Tip: reasoning models

Models like `deepseek-v4-pro` spend tokens on reasoning. Give `max_tokens` enough headroom (≥500) or the visible answer may be empty.

## Billing

- Text: token-based credit.
- Images: from ¥0.06/image.
- Video: per-second (e.g. MiniMax 480p ¥0.048/s); rate limit 5 req/min/key.
- `402` means insufficient credit — top up at https://baodan.run/console/topup.

## License

MIT
