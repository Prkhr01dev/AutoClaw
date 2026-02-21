// src/runtime/soul.js — SOUL.md loader and identity provider
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('soul');

let soulContent = null;

/**
 * Load and cache SOUL.md — the immutable agent identity.
 * @param {string} [soulPath] - Path to SOUL.md (default: data/SOUL.md)
 * @returns {string} The SOUL.md content
 */
export function loadSoul(soulPath) {
    const path = soulPath || resolve(process.cwd(), 'data', 'SOUL.md');
    try {
        soulContent = readFileSync(path, 'utf-8');
        log.info({ path, length: soulContent.length }, 'SOUL.md loaded');
        return soulContent;
    } catch (err) {
        log.error({ err, path }, 'Failed to load SOUL.md');
        throw new Error(`Cannot load SOUL.md from ${path}: ${err.message}`);
    }
}

/**
 * Get the cached SOUL content.
 */
export function getSoul() {
    if (!soulContent) {
        loadSoul();
    }
    return soulContent;
}

/**
 * Build the system prompt incorporating SOUL identity.
 * @param {Object} options
 * @param {string} options.chatType - "private" or "group"
 * @param {Array<Object>} options.toolSchemas - Available tool schemas
 * @param {string} [options.memory] - Current MEMORY.md content
 * @param {Array<string>} [options.skills] - Injected skill contents
 * @param {Array<Object>} [options.contextResults] - Relevant context from embeddings
 * @returns {string} The complete system prompt
 */
export function buildSystemPrompt({ chatType, toolSchemas, memory, skills, contextResults }) {
    const parts = [];

    // Core identity
    parts.push(getSoul());

    // Session mode
    parts.push(`\n## Current Session`);
    parts.push(`- **Mode:** ${chatType === 'private' ? 'Full Access (DM)' : 'Sandbox (Group Chat — bash disabled, writes restricted)'}`);
    parts.push(`- **Timestamp:** ${new Date().toISOString()}`);

    // Available tools
    if (toolSchemas?.length > 0) {
        parts.push(`\n## Available Tools\n`);
        for (const tool of toolSchemas) {
            parts.push(`### ${tool.name}`);
            parts.push(`${tool.description}`);
            parts.push(`Parameters: ${JSON.stringify(tool.parameters, null, 2)}\n`);
        }
    }

    // Memory context
    if (memory) {
        parts.push(`\n## Long-Term Memory\n${memory}`);
    }

    // Relevant context from semantic search
    if (contextResults?.length > 0) {
        parts.push(`\n## Relevant Context\n`);
        for (const ctx of contextResults) {
            parts.push(`- [${ctx.source}] ${ctx.content.slice(0, 200)}`);
        }
    }

    // Injected skills
    if (skills?.length > 0) {
        parts.push(`\n## Active Skills\n`);
        for (const skill of skills) {
            parts.push(skill);
        }
    }

    // Response format instruction
    parts.push(`\n## Response Format

You MUST respond with valid JSON in the following structure:

\`\`\`json
{
  "reasoning": "Your step-by-step reasoning about the request",
  "actions": [
    {
      "tool": "tool_name",
      "params": { ... },
      "requires_confirmation": false
    }
  ],
  "response": "Your message to the user",
  "memory_updates": [
    { "category": "User Preferences", "fact": "optional new fact to remember" }
  ]
}
\`\`\`

If no tool actions are needed, return an empty "actions" array.
Always include "reasoning" — never act without explaining why.
If a destructive action is needed, set "requires_confirmation": true.`);

    return parts.join('\n');
}

/**
 * Build a simplified system prompt for lightweight LLM providers (e.g. RapidAPI free tier)
 * that cannot reliably follow JSON schema instructions.
 * These providers receive a plain natural-language persona instead.
 *
 * @param {Object} options
 * @param {string} options.chatType - "private" or "group"
 * @param {string} [options.memory] - Current MEMORY.md content
 * @returns {string} A simple system prompt
 */
export function buildLiteSystemPrompt({ chatType, memory }) {
    const parts = [
        `You are Aatman, a helpful, concise, and intelligent AI assistant.`,
        `You respond naturally in plain text — no JSON, no markdown code blocks, no system-level formatting.`,
        `You are friendly, direct, and smart. Keep responses focused and useful.`,
        chatType === 'group'
            ? `You are currently in a group chat. Be brief and relevant.`
            : `You are in a private conversation. Be helpful and thorough.`,
    ];

    if (memory) {
        parts.push(`\nSome things to remember about this user:\n${memory}`);
    }

    return parts.join('\n');
}
