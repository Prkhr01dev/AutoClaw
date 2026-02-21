// src/runtime/orchestrator.js — Plan → Act → Observe → Iterate execution loop
import { v4 as uuidv4 } from 'uuid';
import { complete } from './llm-adapter.js';
import { buildSystemPrompt, buildLiteSystemPrompt, getSoul } from './soul.js';
import { getMemory, addFact } from './memory-manager.js';
import { matchSkills } from './skill-loader.js';
import { searchSimilar, storeEmbedding } from '../memory/embeddings.js';
import { executeTool, getToolSchemas } from '../tools/tool-registry.js';
import {
    saveExecutionState,
    updateExecutionState,
    completeExecution,
    failExecution,
    storeConversation,
    getConversationHistory,
} from './state-manager.js';
import { audit } from '../memory/audit-log.js';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

const log = createLogger('orchestrator');

/**
 * Providers that cannot reliably follow JSON schema instructions.
 * These get the lite (plain-text) system prompt and bypass the plan parser.
 */
const LITE_PROVIDERS = new Set(['rapidapi', 'ollama']);

/**
 * Parse a JSON plan from LLM output, handling markdown code fences.
 * @param {string} text - Raw LLM output
 * @returns {Object|null} Parsed plan or null
 */
function parsePlan(text) {
    // Try direct JSON parse
    try {
        return JSON.parse(text);
    } catch { /* not plain JSON */ }

    // Try extracting from code fences
    const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;
    const match = text.match(fenceRegex);
    if (match) {
        try {
            return JSON.parse(match[1]);
        } catch { /* malformed JSON in fence */ }
    }

    // Try to find JSON object in text
    const jsonRegex = /\{[\s\S]*"reasoning"[\s\S]*"actions"[\s\S]*\}/;
    const jsonMatch = text.match(jsonRegex);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch { /* not valid JSON */ }
    }

    return null;
}

/**
 * Validate a parsed plan has the required structure.
 */
function validatePlan(plan) {
    if (!plan || typeof plan !== 'object') return false;
    if (typeof plan.reasoning !== 'string') return false;
    if (!Array.isArray(plan.actions)) return false;
    if (typeof plan.response !== 'string') return false;

    for (const action of plan.actions) {
        if (!action.tool || !action.params) return false;
    }

    return true;
}

/**
 * Main message handler — the orchestration entry point.
 *
 * @param {Object} normalizedMsg - Normalized message from the gateway
 * @param {string} normalizedMsg.id
 * @param {string} normalizedMsg.platform
 * @param {string} normalizedMsg.user_id
 * @param {string} normalizedMsg.chat_id
 * @param {string} normalizedMsg.chat_type - "private" | "group"
 * @param {string} normalizedMsg.timestamp
 * @param {string} normalizedMsg.message
 * @param {Function} sendMessage - Function to send messages back to the user
 * @returns {Promise<string>} Response text
 */
export async function handleMessage(normalizedMsg, sendMessage) {
    const { user_id, chat_id, chat_type, message, platform } = normalizedMsg;
    const maxIterations = getConfig('security.maxIterations', 10);
    const inputMaxLength = getConfig('security.inputMaxLength', 10000);

    // Input validation
    if (!message || typeof message !== 'string') {
        return 'I received an empty message. Please try again.';
    }

    if (message.length > inputMaxLength) {
        return `Message too long (${message.length} chars, max: ${inputMaxLength}). Please shorten your message.`;
    }

    log.info({ user_id, chat_id, chat_type, msgLength: message.length }, 'Handling message');

    // Store inbound message
    storeConversation({
        id: normalizedMsg.id,
        userId: user_id,
        chatId: chat_id,
        platform,
        role: 'user',
        content: message,
    });

    // Store embedding for semantic retrieval
    try {
        storeEmbedding(message, 'conversation', chat_id);
    } catch (err) {
        log.warn({ err }, 'Failed to store message embedding');
    }

    // Build context
    const memory = getMemory();
    const provider = getConfig('llm.provider', 'anthropic');
    const isLiteProvider = LITE_PROVIDERS.has(provider);
    const conversationHistory = getConversationHistory(chat_id, 20);

    let contextResults = [];
    try {
        contextResults = searchSimilar(message, getConfig('memory.maxContextResults', 5));
    } catch (err) {
        log.warn({ err }, 'Semantic search failed');
    }

    let systemPrompt;
    let messages;

    if (isLiteProvider) {
        // Lite providers: simple plain-text prompt, no tool schemas, no JSON format
        systemPrompt = buildLiteSystemPrompt({ chatType: chat_type, memory });
        messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory.map((c) => ({ role: c.role, content: c.content })),
            { role: 'user', content: message },
        ];
    } else {
        // Full providers: complete structured prompt with tools + JSON schema
        const toolSchemas = getToolSchemas(chat_type);
        const matchedSkills = matchSkills(message).map((s) => s.content);
        systemPrompt = buildSystemPrompt({
            chatType: chat_type,
            toolSchemas,
            memory,
            skills: matchedSkills,
            contextResults,
        });
        messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory.map((c) => ({ role: c.role, content: c.content })),
            { role: 'user', content: message },
        ];
    }

    // --- Plan → Act → Observe → Iterate Loop ---
    let iterations = 0;
    let finalResponse = '';
    let stateId = null;

    try {
        // For lite providers (e.g. RapidAPI), skip the plan/JSON loop entirely
        if (isLiteProvider) {
            const llmResult = await complete(messages);
            finalResponse = llmResult.content || 'Sorry, I could not generate a response.';

            storeConversation({
                userId: user_id,
                chatId: chat_id,
                platform,
                role: 'assistant',
                content: finalResponse,
            });

            log.info({ user_id, chat_id, provider, responseLength: finalResponse.length }, 'Lite provider response complete');
            return finalResponse;
        }

        while (iterations < maxIterations) {
            iterations++;
            log.info({ iteration: iterations, maxIterations }, 'Orchestration iteration');

            // 1. PLAN — Call LLM to get structured plan
            const llmResult = await complete(messages);
            const plan = parsePlan(llmResult.content);

            if (!plan) {
                log.warn({ rawContent: llmResult.content.slice(0, 200) }, 'LLM returned unparseable response');
                // Treat raw response as conversational reply
                finalResponse = llmResult.content;
                break;
            }

            if (!validatePlan(plan)) {
                log.warn({ plan }, 'LLM returned invalid plan structure');
                finalResponse = plan.response || llmResult.content;
                break;
            }

            audit({
                action: 'plan_generated',
                userId: user_id,
                chatId: chat_id,
                params: { reasoning: plan.reasoning, actionCount: plan.actions.length, iteration: iterations },
                status: 'success',
            });

            // No actions = conversation-only response
            if (plan.actions.length === 0) {
                finalResponse = plan.response;
                break;
            }

            // 2. Save execution state for restart recovery
            if (!stateId) {
                stateId = saveExecutionState({ chatId: chat_id, userId: user_id, plan });
            }

            // 3. ACT — Execute each action
            let needsReiteration = false;
            const observations = [];

            for (let i = 0; i < plan.actions.length; i++) {
                const action = plan.actions[i];
                log.info({ tool: action.tool, step: i, iteration: iterations }, 'Executing action');

                try {
                    const result = await executeTool(action.tool, action.params, {
                        userId: user_id,
                        chatId: chat_id,
                        chatType: chat_type,
                        sendMessage,
                    });

                    observations.push({ step: i, tool: action.tool, result });
                    updateExecutionState(stateId, i, result);

                    // If a tool result suggests more work needed
                    if (!result.success && !result.denied) {
                        needsReiteration = true;
                    }
                } catch (err) {
                    log.error({ err, tool: action.tool, step: i }, 'Tool execution error');
                    observations.push({ step: i, tool: action.tool, error: err.message });
                    updateExecutionState(stateId, i, { error: err.message }, 'in_progress');
                    needsReiteration = true;
                }
            }

            // 4. OBSERVE — Feed observations back to LLM if needed
            if (needsReiteration && iterations < maxIterations) {
                const observationSummary = observations
                    .map((o) => `Step ${o.step} (${o.tool}): ${JSON.stringify(o.result || o.error).slice(0, 500)}`)
                    .join('\n');

                messages.push({ role: 'assistant', content: JSON.stringify(plan) });
                messages.push({
                    role: 'user',
                    content: `[SYSTEM] Tool execution results:\n${observationSummary}\n\nSome actions failed. Review the observations and decide next steps. Respond with a new JSON plan.`,
                });

                log.info({ iteration: iterations }, 'Re-iterating with observations');
                continue;
            }

            // 5. Handle memory updates from the plan
            if (plan.memory_updates?.length > 0) {
                for (const update of plan.memory_updates) {
                    try {
                        addFact(update.category, update.fact);
                    } catch (err) {
                        log.warn({ err, update }, 'Failed to add memory update');
                    }
                }
            }

            finalResponse = plan.response;

            // Add observation summaries to response if useful
            const toolResults = observations.filter((o) => o.result?.success);
            if (toolResults.length > 0 && !finalResponse.includes('```')) {
                const resultSummary = toolResults
                    .map((o) => {
                        const r = o.result;
                        if (r.stdout) return `\`${o.tool}\`: ${r.stdout.slice(0, 200)}`;
                        if (r.content) return `\`${o.tool}\`: ${typeof r.content === 'string' ? r.content.slice(0, 200) : 'OK'}`;
                        return `\`${o.tool}\`: ✅`;
                    })
                    .join('\n');
                finalResponse += `\n\n**Results:**\n${resultSummary}`;
            }

            break;
        }

        // Mark execution as complete
        if (stateId) {
            completeExecution(stateId);
        }
    } catch (err) {
        log.error({ err, user_id, chat_id }, 'Orchestration error');
        if (stateId) failExecution(stateId, err.message);
        finalResponse = `⚠️ An error occurred while processing your request: ${err.message}`;
    }

    // Store outbound response
    storeConversation({
        userId: user_id,
        chatId: chat_id,
        platform,
        role: 'assistant',
        content: finalResponse,
    });

    log.info({ user_id, chat_id, iterations, responseLength: finalResponse.length }, 'Message handling complete');
    return finalResponse;
}

/**
 * Resume incomplete executions after restart.
 * @param {Function} sendMessage
 */
export async function recoverIncompleteExecutions(sendMessage) {
    const { getIncompleteExecutions, rollbackExecution } = await import('./state-manager.js');
    const incomplete = getIncompleteExecutions();

    if (incomplete.length === 0) {
        log.info('No incomplete executions to recover');
        return;
    }

    log.warn({ count: incomplete.length }, 'Found incomplete executions — rolling back');

    for (const exec of incomplete) {
        try {
            rollbackExecution(exec.id);
            if (sendMessage) {
                await sendMessage(
                    exec.chat_id,
                    `⚠️ A previous execution was interrupted and has been safely rolled back.\n` +
                    `Plan: ${exec.plan.reasoning?.slice(0, 100) || 'unknown'}...`
                );
            }
        } catch (err) {
            log.error({ err, execId: exec.id }, 'Failed to recover execution');
        }
    }
}
