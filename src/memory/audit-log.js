// src/memory/audit-log.js — Append-only JSONL audit logging
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('audit-log');

let auditStream = null;
let auditPath = null;

/**
 * Initialize the audit log writer.
 * @param {string} logPath - Path to the JSONL audit file
 */
export function initAuditLog(logPath) {
    auditPath = logPath;
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    auditStream = createWriteStream(logPath, { flags: 'a', encoding: 'utf-8' });
    auditStream.on('error', (err) => {
        log.error({ err }, 'Audit log write error');
    });

    log.info({ logPath }, 'Audit log initialized');
}

/**
 * Write a structured audit entry.
 * @param {Object} entry
 * @param {string} entry.action - Action type (e.g., "tool_execute", "plan_create", "hitl_confirm")
 * @param {string} [entry.tool] - Tool name if applicable
 * @param {string} [entry.userId] - User ID
 * @param {string} [entry.chatId] - Chat ID
 * @param {Object} [entry.params] - Action parameters
 * @param {Object} [entry.result] - Execution result
 * @param {string} [entry.status] - Status: "success", "error", "pending"
 * @param {string} [entry.error] - Error message if applicable
 */
export function audit(entry) {
    if (!auditStream) {
        log.warn('Audit log not initialized, skipping entry');
        return;
    }

    const record = {
        timestamp: new Date().toISOString(),
        ...entry,
    };

    auditStream.write(JSON.stringify(record) + '\n');
    log.debug({ action: entry.action, tool: entry.tool }, 'Audit entry written');
}

/**
 * Flush and close the audit log.
 */
export function closeAuditLog() {
    return new Promise((resolve) => {
        if (auditStream) {
            auditStream.end(() => {
                log.info('Audit log closed');
                auditStream = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}
