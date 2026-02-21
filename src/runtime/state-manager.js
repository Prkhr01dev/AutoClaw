// src/runtime/state-manager.js — Restart-safe execution state persistence
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../memory/database.js';
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';

const log = createLogger('state-manager');

/**
 * Save a new execution plan to the database.
 * @param {Object} opts
 * @param {string} opts.chatId
 * @param {string} opts.userId
 * @param {Object} opts.plan - The structured execution plan from the LLM
 * @returns {string} Execution state ID
 */
export function saveExecutionState({ chatId, userId, plan }) {
    const db = getDb();
    const id = uuidv4();

    db.prepare(`
    INSERT INTO execution_state (id, chat_id, user_id, plan, status, current_step, observations)
    VALUES (?, ?, ?, ?, 'in_progress', 0, '[]')
  `).run(id, chatId, userId, JSON.stringify(plan));

    log.info({ id, chatId, steps: plan.actions?.length || 0 }, 'Execution state saved');
    return id;
}

/**
 * Update execution state after completing a step.
 * @param {string} id - State ID
 * @param {number} step - Current step index
 * @param {Object} observation - Tool output from the step
 * @param {string} [status] - New status ("in_progress" | "completed" | "failed" | "rolled_back")
 */
export function updateExecutionState(id, step, observation, status = 'in_progress') {
    const db = getDb();

    // Get current observations
    const row = db.prepare('SELECT observations FROM execution_state WHERE id = ?').get(id);
    if (!row) {
        log.warn({ id }, 'Execution state not found for update');
        return;
    }

    const observations = JSON.parse(row.observations);
    observations.push({ step, observation, timestamp: new Date().toISOString() });

    db.prepare(`
    UPDATE execution_state
    SET current_step = ?, observations = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(step, JSON.stringify(observations), status, id);

    log.debug({ id, step, status }, 'Execution state updated');
}

/**
 * Mark execution as completed.
 */
export function completeExecution(id) {
    updateExecutionState(id, -1, { note: 'completed' }, 'completed');
    audit({ action: 'execution_complete', params: { stateId: id }, status: 'success' });
    log.info({ id }, 'Execution completed');
}

/**
 * Mark execution as failed.
 */
export function failExecution(id, error) {
    const db = getDb();
    db.prepare(`
    UPDATE execution_state SET status = 'failed', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);

    audit({ action: 'execution_failed', params: { stateId: id }, status: 'error', error });
    log.error({ id, error }, 'Execution failed');
}

/**
 * Get all in-progress execution states (for restart recovery).
 * @returns {Array<Object>}
 */
export function getIncompleteExecutions() {
    const db = getDb();
    const rows = db.prepare(`
    SELECT * FROM execution_state
    WHERE status = 'in_progress'
    ORDER BY created_at ASC
  `).all();

    return rows.map((row) => ({
        ...row,
        plan: JSON.parse(row.plan),
        observations: JSON.parse(row.observations),
    }));
}

/**
 * Roll back (mark as rolled_back) an incomplete execution.
 */
export function rollbackExecution(id) {
    const db = getDb();
    db.prepare(`
    UPDATE execution_state SET status = 'rolled_back', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);

    audit({ action: 'execution_rollback', params: { stateId: id }, status: 'success' });
    log.warn({ id }, 'Execution rolled back');
}

/**
 * Store conversation message for history.
 */
export function storeConversation({ id, userId, chatId, platform, role, content, metadata }) {
    const db = getDb();
    db.prepare(`
    INSERT INTO conversations (id, user_id, chat_id, platform, role, content, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id || uuidv4(), userId, chatId, platform, role, content, metadata ? JSON.stringify(metadata) : null);
}

/**
 * Get recent conversation history for a chat.
 * @param {string} chatId
 * @param {number} [limit=20]
 */
export function getConversationHistory(chatId, limit = 20) {
    const db = getDb();
    return db.prepare(`
    SELECT * FROM conversations
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, limit).reverse();
}
