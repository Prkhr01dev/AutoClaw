# 🧠 Aatman Gateway

**Agency over Chat** — A local-first autonomous AI agent platform that reasons, plans, acts, and persists.

Aatman is not a chatbot. It's an execution-capable agent that receives messages via Telegram, generates structured execution plans, safely acts on the host environment inside Docker, persists semantic memory locally, and proactively initiates actions on schedules.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Messaging Gateway  (src/gateway/)                     │
│  grammY + Zod schema normalization + rate limiting              │
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Agent Runtime  (src/runtime/)                         │
│  Plan → Act → Observe → Iterate orchestration loop              │
│  SOUL.md identity │ MEMORY.md facts │ Skill injection           │
│  Model-agnostic LLM adapter (Claude / GPT-4o / Ollama)         │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: Execution Layer  (src/tools/)                         │
│  fs_tool (sandboxed) │ bash_tool (HITL) │ browser_tool          │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: Memory & Persistence  (src/memory/)                   │
│  SQLite + sqlite-vec │ JSONL audit logs │ node-cron scheduler   │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Configure

Edit `config.json`:
```json
{
  "telegram": { "botToken": "YOUR_BOT_TOKEN" },
  "llm": { "provider": "anthropic", "apiKey": "YOUR_API_KEY" }
}
```

### 2. Run with Docker (recommended)

```bash
docker compose up --build
```

### 3. Run locally (development)

```bash
npm install
npm run dev
```

### 4. Message your bot on Telegram

Send any message — Aatman will plan, execute, and respond.

## Security

- **Non-root Docker container** with resource limits and read-only root
- **Path traversal prevention** on all filesystem operations
- **Destructive command detection** (rm -rf, shutdown, docker controls, etc.)
- **Human-in-the-Loop confirmation** for dangerous actions (persisted across restarts)
- **Group chat sandbox** mode (bash disabled, writes blocked)
- **LLM output sanitization** against prompt injection
- **Rate limiting** on both Telegram messages and LLM API calls
- **Full audit trail** via append-only JSONL logs

## Testing

```bash
npm test            # All tests
npm run test:unit   # Unit tests only
```

## Key Files

| File | Purpose |
|------|---------|
| `data/SOUL.md` | Immutable agent identity & safety constraints |
| `data/MEMORY.md` | Long-term learned facts & preferences |
| `data/skills/*.md` | Procedural skill templates (auto-injected) |
| `config.json` | All configuration (LLM, Telegram, tools, security) |


