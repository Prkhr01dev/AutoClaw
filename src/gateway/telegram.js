// src/gateway/telegram.js — Stateless Telegram gateway via grammY
import { Bot } from 'grammy';
import { v4 as uuidv4 } from 'uuid';
import { validateMessage } from './schema.js';
import { handleMessage } from '../runtime/orchestrator.js';
import { parseConfirmationResponse, approveConfirmation, denyConfirmation, getPendingConfirmations } from '../tools/hitl.js';
import { audit } from '../memory/audit-log.js';
import { createLogger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';

const log = createLogger('telegram');

let bot = null;

/** Rate limiting state */
const rateLimiter = new Map();

/**
 * Check rate limit for a user.
 * @param {string} userId
 * @returns {boolean} true if allowed
 */
function checkUserRateLimit(userId) {
    const limit = getConfig('telegram.rateLimitPerMinute', 20);
    const now = Date.now();
    const window = rateLimiter.get(userId) || { count: 0, resetTime: now + 60000 };

    if (now > window.resetTime) {
        window.count = 0;
        window.resetTime = now + 60000;
    }

    window.count++;
    rateLimiter.set(userId, window);

    return window.count <= limit;
}

/**
 * Check if a user is allowed to interact with the bot.
 * @param {string} userId
 * @returns {boolean}
 */
function isUserAllowed(userId) {
    const allowedIds = getConfig('telegram.allowedUserIds', []);
    // Empty allowlist = everyone allowed
    if (allowedIds.length === 0) return true;
    return allowedIds.includes(Number(userId)) || allowedIds.includes(userId);
}

/**
 * Send a message to a Telegram chat (sendMessage helper for HITL, scheduler etc).
 * @param {string} chatId
 * @param {string} text
 */
async function sendTelegramMessage(chatId, text) {
    if (!bot) throw new Error('Telegram bot not initialized');

    // Split long messages (Telegram limit is 4096 chars)
    const maxLen = 4000;
    const parts = [];
    let remaining = text;
    while (remaining.length > 0) {
        parts.push(remaining.slice(0, maxLen));
        remaining = remaining.slice(maxLen);
    }

    for (const part of parts) {
        try {
            await bot.api.sendMessage(chatId, part, { parse_mode: 'Markdown' });
        } catch {
            // Fallback without markdown if parsing fails
            await bot.api.sendMessage(chatId, part);
        }
    }
}

/**
 * Initialize and start the Telegram bot.
 * @returns {Bot} The grammY bot instance
 */
export function initTelegram() {
    const token = getConfig('telegram.botToken');
    if (!token) {
        throw new Error('Telegram bot token not configured. Set telegram.botToken in config.json');
    }

    bot = new Bot(token);

    // Error handler
    bot.catch((err) => {
        log.error({ err: err.error || err }, 'Telegram bot error');
    });

    // Handle all text messages
    bot.on('message:text', async (ctx) => {
        const userId = String(ctx.from.id);
        const chatId = String(ctx.chat.id);
        const messageText = ctx.message.text;
        const messageId = String(ctx.message.message_id);

        // Auth check
        if (!isUserAllowed(userId)) {
            log.warn({ userId }, 'Unauthorized user attempted access');
            return;
        }

        // Rate limit check
        if (!checkUserRateLimit(userId)) {
            await ctx.reply('⏳ Rate limit exceeded. Please wait a moment.');
            return;
        }

        // Check if this is a HITL confirmation response first
        const confirmResponse = parseConfirmationResponse(messageText);
        if (confirmResponse.isResponse) {
            const pending = getPendingConfirmations(chatId);
            if (pending.length > 0) {
                const latest = pending[0];
                if (confirmResponse.approved) {
                    approveConfirmation(latest.id);
                    await ctx.reply('✅ Action approved. Executing...');
                } else {
                    denyConfirmation(latest.id);
                    await ctx.reply('❌ Action denied.');
                }
                return;
            }
        }

        // Determine chat type
        const chatType = ctx.chat.type === 'private' ? 'private' : 'group';

        // Normalize message
        const normalizedMsg = {
            id: uuidv4(),
            platform: 'telegram',
            user_id: userId,
            chat_id: chatId,
            chat_type: chatType,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
            message: messageText,
        };

        // Validate
        const validation = validateMessage(normalizedMsg);
        if (!validation.success) {
            log.warn({ error: validation.error, userId }, 'Message validation failed');
            await ctx.reply('❌ Invalid message format.');
            return;
        }

        audit({
            action: 'message_received',
            userId,
            chatId,
            params: { platform: 'telegram', chatType, messageLength: messageText.length },
            status: 'success',
        });

        // Show typing indicator
        await ctx.replyWithChatAction('typing');

        try {
            // Pass to orchestrator
            const response = await handleMessage(normalizedMsg, sendTelegramMessage);

            // Send response back
            if (response) {
                await sendTelegramMessage(chatId, response);
            }
        } catch (err) {
            log.error({ err, userId, chatId }, 'Failed to handle message');
            await ctx.reply('⚠️ An error occurred while processing your message. Please try again.');
        }
    });

    // Handle /start command
    bot.command('start', async (ctx) => {
        const userId = String(ctx.from.id);
        const chatId = String(ctx.chat.id);

        // Auth check
        if (!isUserAllowed(userId)) {
            log.warn({ userId }, 'Unauthorized user attempted /start');
            return;
        }

        // Send static welcome
        await ctx.reply(
            '🧠 **Aatman Gateway — Active**\n\n' +
            'I am an autonomous AI agent operating under the principle of _Agency over Chat_.\n\n' +
            'I can:\n' +
            '• Execute shell commands safely\n' +
            '• Read and write files in the workspace\n' +
            '• Browse websites and extract data\n' +
            '• Schedule monitoring tasks\n' +
            '• Remember your preferences\n\n' +
            'Tell me what you need — I\'ll plan, execute, and report back.',
            { parse_mode: 'Markdown' }
        );

        // Also route through orchestrator so the AI can respond conversationally
        const chatType = ctx.chat.type === 'private' ? 'private' : 'group';
        const normalizedMsg = {
            id: uuidv4(),
            platform: 'telegram',
            user_id: userId,
            chat_id: chatId,
            chat_type: chatType,
            timestamp: new Date(ctx.message.date * 1000).toISOString(),
            message: 'Hello! I just started the bot. Please greet me briefly.',
        };

        try {
            await ctx.replyWithChatAction('typing');
            const response = await handleMessage(normalizedMsg, sendTelegramMessage);
            if (response) {
                await sendTelegramMessage(chatId, response);
            }
        } catch (err) {
            log.error({ err, userId, chatId }, 'Failed to handle /start via orchestrator');
        }
    });

    // Handle /status command
    bot.command('status', async (ctx) => {
        const chatType = ctx.chat.type === 'private' ? 'Full Access' : 'Sandbox Mode';
        await ctx.reply(
            `📊 **Status**\n\n` +
            `• Mode: ${chatType}\n` +
            `• Platform: Telegram\n` +
            `• Engine: Running`,
            { parse_mode: 'Markdown' }
        );
    });

    return bot;
}

/**
 * Start the bot polling.
 */
export async function startTelegram() {
    if (!bot) throw new Error('Telegram bot not initialized. Call initTelegram() first.');

    log.info('Starting Telegram bot polling...');
    bot.start({
        onStart: (botInfo) => {
            log.info({ username: botInfo.username, id: botInfo.id }, 'Telegram bot started');
        },
    });
}

/**
 * Stop the bot gracefully.
 */
export async function stopTelegram() {
    if (bot) {
        await bot.stop();
        log.info('Telegram bot stopped');
    }
}

/**
 * Get the sendMessage function (for scheduler / proactive messaging).
 */
export function getSendMessage() {
    return sendTelegramMessage;
}
