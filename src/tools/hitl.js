// src/tools/hitl.js — Human-in-the-Loop confirmation workflow
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../memory/database.js';
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';

const log = createLogger('hitl');

/** @type {Map<string, { resolve: Function, reject: Function }>} */
const pendingResolvers = new Map();

/**
 * Create a pending confirmation request and wait for user response.
 * The confirmation is persisted to the database for restart safety.
 *
 * @param {Object} opts
 * @param {string} opts.chatId - Chat to send confirmation to
 * @param {string} opts.userId - User to confirm
 * @param {string} opts.tool - Tool that requires confirmation
 * @param {string} opts.action - Description of the action
 * @param {Object} opts.params - Full parameters of the action
 * @param {Function} opts.sendMessage - Function to send the confirmation message
 * @returns {Promise<boolean>} - True if approved, false if denied
 */
export async function requestConfirmation({ chatId, userId, tool, action, params, sendMessage }) {
    const db = getDb();
    const id = uuidv4();

    // Persist pending confirmation
    db.prepare(`
    INSERT INTO pending_confirmations (id, chat_id, user_id, action, tool, params, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, chatId, userId, action, tool, JSON.stringify(params));

    audit({ action: 'hitl_request', tool, userId, chatId, params: { confirmationId: id, action }, status: 'pending' });

    // Send confirmation message to user
    const message = `⚠️ **Confirmation Required**\n\n` +
        `**Tool:** \`${tool}\`\n` +
        `**Action:** ${action}\n` +
        `**Details:** \`${JSON.stringify(params).slice(0, 500)}\`\n\n` +
        `Reply **Y** to approve or **N** to deny.\n` +
        `_(ID: ${id.slice(0, 8)})_`;

    await sendMessage(chatId, message);
    log.info({ id, tool, action }, 'HITL confirmation requested');

    // Wait for resolution via resolveConfirmation()
    return new Promise((resolve, reject) => {
        pendingResolvers.set(id, { resolve, reject });

        // Timeout after 5 minutes
        setTimeout(() => {
            if (pendingResolvers.has(id)) {
                pendingResolvers.delete(id);
                denyConfirmation(id);
                resolve(false);
                log.warn({ id }, 'HITL confirmation timed out — auto-denied');
            }
        }, 5 * 60 * 1000);
    });
}

/**
 * Approve a pending confirmation.
 * @param {string} confirmationId
 */
export function approveConfirmation(confirmationId) {
    const db = getDb();

    // Support partial ID matching (first 8 chars)
    let id = confirmationId;
    if (id.length < 36) {
        const row = db.prepare("SELECT id FROM pending_confirmations WHERE status = 'pending' AND id LIKE ?").get(`${id}%`);
        if (row) id = row.id;
    }

    db.prepare(`
    UPDATE pending_confirmations SET status = 'approved', resolved_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);

    audit({ action: 'hitl_approve', params: { confirmationId: id }, status: 'success' });
    log.info({ id }, 'HITL confirmation approved');

    if (pendingResolvers.has(id)) {
        pendingResolvers.get(id).resolve(true);
        pendingResolvers.delete(id);
    }
}

/**
 * Deny a pending confirmation.
 * @param {string} confirmationId
 */
export function denyConfirmation(confirmationId) {
    const db = getDb();

    let id = confirmationId;
    if (id.length < 36) {
        const row = db.prepare("SELECT id FROM pending_confirmations WHERE status = 'pending' AND id LIKE ?").get(`${id}%`);
        if (row) id = row.id;
    }

    db.prepare(`
    UPDATE pending_confirmations SET status = 'denied', resolved_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);

    audit({ action: 'hitl_deny', params: { confirmationId: id }, status: 'success' });
    log.info({ id }, 'HITL confirmation denied');

    if (pendingResolvers.has(id)) {
        pendingResolvers.get(id).resolve(false);
        pendingResolvers.delete(id);
    }
}

/**
 * Check if a message is a HITL response (Y/N).
 * @param {string} text
 * @returns {{ isResponse: boolean, approved: boolean }}
 */
export function parseConfirmationResponse(text) {
    const cleaned = text.trim().toUpperCase();
    if (cleaned === 'Y' || cleaned === 'YES') return { isResponse: true, approved: true };
    if (cleaned === 'N' || cleaned === 'NO') return { isResponse: true, approved: false };
    return { isResponse: false, approved: false };
}

/**
 * Get all pending confirmations for a chat.
 */
export function getPendingConfirmations(chatId) {
    return getDb()
        .prepare("SELECT * FROM pending_confirmations WHERE chat_id = ? AND status = 'pending' ORDER BY created_at DESC")
        .all(chatId);
}

/**
 * Recover pending confirmations after restart (re-establish resolvers is not possible,
 * but the state is preserved in DB for the orchestrator to re-trigger).
 */
export function getOrphanedConfirmations() {
    return getDb()
        .prepare("SELECT * FROM pending_confirmations WHERE status = 'pending'")
        .all();
}
