// src/runtime/llm-adapter.js — Model-agnostic LLM interface
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

const log = createLogger('llm-adapter');

let callCount = 0;
let lastResetTime = Date.now();

/**
 * Check and enforce rate limiting.
 */
function checkRateLimit() {
    const limit = getConfig('llm.rateLimitPerMinute', 30);
    const now = Date.now();

    // Reset counter every minute
    if (now - lastResetTime > 60000) {
        callCount = 0;
        lastResetTime = now;
    }

    callCount++;
    if (callCount > limit) {
        throw new Error(`LLM rate limit exceeded: ${callCount}/${limit} calls per minute`);
    }
}

/**
 * Sleep utility for retry backoff.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitize LLM output to prevent injection attacks.
 * Strips potential system prompt overrides and dangerous patterns.
 */
export function sanitizeLLMOutput(text) {
    if (typeof text !== 'string') return '';

    // Strip common injection patterns
    let sanitized = text
        .replace(/```system\b[\s\S]*?```/gi, '[REDACTED: system block]')
        .replace(/\[SYSTEM\][\s\S]*?\[\/SYSTEM\]/gi, '[REDACTED: system override]')
        .replace(/<\|im_start\|>system[\s\S]*?<\|im_end\|>/gi, '[REDACTED: prompt injection]');

    // Strip promotional spam injected by RapidAPI LLM providers (e.g., Discord links)
    sanitized = sanitized
        .replace(/\bdiscord\.gg\/\S+/gi, '')
        .replace(/\bhttps?:\/\/discord\.gg\/\S*/gi, '')
        .replace(/join\s+(our\s+)?(discord|community|server)[\s\S]{0,100}discord\.gg\/\S*/gi, '')
        .trim();

    return sanitized;
}

/**
 * Call the Anthropic Claude API.
 */
async function callAnthropic(messages, options) {
    const apiKey = getConfig('llm.apiKey');
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const model = getConfig('llm.model', 'claude-sonnet-4-20250514');
    const maxTokens = options.maxTokens || getConfig('llm.maxTokens', 4096);
    const temperature = options.temperature ?? getConfig('llm.temperature', 0.3);

    // Separate system message from conversation messages
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const body = {
        model,
        max_tokens: maxTokens,
        temperature,
        messages: conversationMessages,
    };

    if (systemMessage) {
        body.system = systemMessage.content;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return {
        content: data.content?.[0]?.text || '',
        usage: {
            inputTokens: data.usage?.input_tokens,
            outputTokens: data.usage?.output_tokens,
        },
        model: data.model,
    };
}

/**
 * Call the OpenAI API.
 */
async function callOpenAI(messages, options) {
    const apiKey = getConfig('llm.apiKey');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const model = getConfig('llm.model', 'gpt-4o');
    const maxTokens = options.maxTokens || getConfig('llm.maxTokens', 4096);
    const temperature = options.temperature ?? getConfig('llm.temperature', 0.3);
    const baseUrl = getConfig('llm.baseUrl', 'https://api.openai.com/v1');

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return {
        content: data.choices?.[0]?.message?.content || '',
        usage: {
            inputTokens: data.usage?.prompt_tokens,
            outputTokens: data.usage?.completion_tokens,
        },
        model: data.model,
    };
}

/**
 * Call Ollama (local LLM).
 */
async function callOllama(messages, options) {
    const model = getConfig('llm.model', 'llama3');
    const baseUrl = getConfig('llm.ollamaUrl', 'http://localhost:11434');

    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
            options: {
                temperature: options.temperature ?? getConfig('llm.temperature', 0.3),
                num_predict: options.maxTokens || getConfig('llm.maxTokens', 4096),
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return {
        content: data.message?.content || '',
        usage: {
            inputTokens: data.eval_count,
            outputTokens: data.eval_count,
        },
        model,
    };
}

/**
 * Call Google Gemini API.
 */
async function callGemini(messages, options) {
    const apiKey = getConfig('llm.apiKey');
    if (!apiKey) throw new Error('Gemini API key not configured');

    const model = getConfig('llm.model', 'gemini-2.0-flash');
    const temperature = options.temperature ?? getConfig('llm.temperature', 0.3);
    const maxTokens = options.maxTokens || getConfig('llm.maxTokens', 4096);

    // Convert messages to Gemini format
    const systemInstruction = messages.find((m) => m.role === 'system');
    const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

    const body = {
        contents,
        generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
        },
    };

    if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction.content }] };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return {
        content: text,
        usage: {
            inputTokens: data.usageMetadata?.promptTokenCount,
            outputTokens: data.usageMetadata?.candidatesTokenCount,
        },
        model,
    };
}

/**
 * Call RapidAPI chatgpt-42 endpoint.
 */
async function callRapidAPI(messages, options) {
    const apiKey = getConfig('llm.apiKey');
    if (!apiKey) throw new Error('RapidAPI key not configured');

    const model = getConfig('llm.model', 'conversationgpt4-2');
    const temperature = options.temperature ?? getConfig('llm.temperature', 0.9);
    const maxTokens = options.maxTokens || getConfig('llm.maxTokens', 256);

    const systemMessage = messages.find((m) => m.role === 'system');
    const systemPrompt = systemMessage ? systemMessage.content : '';
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const body = {
        messages: conversationMessages,
        system_prompt: systemPrompt,
        temperature,
        top_k: 5,
        top_p: 0.9,
        max_tokens: maxTokens,
        web_access: false
    };

    const host = "chatgpt-42.p.rapidapi.com";
    const url = `https://${host}/${model}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'x-rapidapi-key': apiKey,
            'x-rapidapi-host': host,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`RapidAPI error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return {
        content: data.result || '',
        usage: {
            inputTokens: 0,
            outputTokens: 0,
        },
        model,
    };
}

/** Provider dispatch map */
const providers = {
    anthropic: callAnthropic,
    openai: callOpenAI,
    ollama: callOllama,
    gemini: callGemini,
    rapidapi: callRapidAPI,
};

/**
 * Unified LLM completion interface with retry logic.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} [options]
 * @param {number} [options.maxTokens]
 * @param {number} [options.temperature]
 * @returns {Promise<{content: string, usage: Object, model: string}>}
 */
export async function complete(messages, options = {}) {
    checkRateLimit();

    const provider = getConfig('llm.provider', 'anthropic');
    const callProvider = providers[provider];

    if (!callProvider) {
        throw new Error(`Unknown LLM provider: ${provider}. Supported: ${Object.keys(providers).join(', ')}`);
    }

    const maxRetries = getConfig('llm.retryAttempts', 3);
    const retryDelay = getConfig('llm.retryDelayMs', 1000);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await callProvider(messages, options);
            result.content = sanitizeLLMOutput(result.content);

            log.info({
                provider,
                model: result.model,
                inputTokens: result.usage?.inputTokens,
                outputTokens: result.usage?.outputTokens,
                attempt,
            }, 'LLM completion successful');

            return result;
        } catch (err) {
            log.warn({ err, provider, attempt, maxRetries }, `LLM call failed (attempt ${attempt}/${maxRetries})`);

            if (attempt === maxRetries) {
                throw err;
            }

            // Exponential backoff
            await sleep(retryDelay * Math.pow(2, attempt - 1));
        }
    }
}
