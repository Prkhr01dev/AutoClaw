// src/gateway/schema.js — Unified message schema with Zod validation
import { z } from 'zod';

/**
 * Normalized inbound message schema.
 * Every message from any platform is converted to this format.
 */
export const NormalizedMessageSchema = z.object({
    id: z.string().min(1),
    platform: z.enum(['telegram', 'whatsapp']),
    user_id: z.string().min(1),
    chat_id: z.string().min(1),
    chat_type: z.enum(['private', 'group']),
    timestamp: z.string().datetime(),
    message: z.string().min(1).max(10000),
});

/**
 * Outbound agent response schema.
 */
export const AgentResponseSchema = z.object({
    chat_id: z.string().min(1),
    text: z.string().min(1),
    parse_mode: z.enum(['Markdown', 'HTML', 'MarkdownV2']).optional(),
    reply_to_message_id: z.number().optional(),
});

/**
 * Validate and normalize an inbound message.
 * @param {Object} data
 * @returns {{ success: boolean, data?: Object, error?: string }}
 */
export function validateMessage(data) {
    const result = NormalizedMessageSchema.safeParse(data);
    if (result.success) {
        return { success: true, data: result.data };
    }
    return {
        success: false,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
}

/**
 * Validate an outbound response.
 * @param {Object} data
 * @returns {{ success: boolean, data?: Object, error?: string }}
 */
export function validateResponse(data) {
    const result = AgentResponseSchema.safeParse(data);
    if (result.success) {
        return { success: true, data: result.data };
    }
    return {
        success: false,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
}
