// src/index.js — Aatman Gateway entry point
// Bootstraps all layers: Memory → Tools → Runtime → Gateway
import { initLogger, createLogger } from './utils/logger.js';
import { loadConfig, getConfig } from './utils/config.js';
import { initDatabase, closeDatabase } from './memory/database.js';
import { initAuditLog, closeAuditLog } from './memory/audit-log.js';
import { loadScheduledTasks, stopAllJobs, setJobTriggerCallback } from './memory/scheduler.js';
import { loadSoul } from './runtime/soul.js';
import { loadMemory } from './runtime/memory-manager.js';
import { loadSkills } from './runtime/skill-loader.js';
import { recoverIncompleteExecutions, handleMessage } from './runtime/orchestrator.js';
import { initTelegram, startTelegram, stopTelegram, getSendMessage } from './gateway/telegram.js';

// ─── Initialize ──────────────────────────────────────────────

const config = loadConfig();
const logger = initLogger(config.logging?.level || 'info');
const log = createLogger('main');

log.info('═══════════════════════════════════════════');
log.info('  Aatman Gateway — Agency over Chat');
log.info('═══════════════════════════════════════════');
log.info({ nodeVersion: process.version, pid: process.pid }, 'Starting up...');

// ─── Layer 4: Memory & Persistence ──────────────────────────

log.info('Initializing Memory & Persistence layer...');
const dbPath = getConfig('memory.dbPath', './data/aatman.db');
initDatabase(dbPath);
initAuditLog(getConfig('logging.auditLogPath', './data/logs/audit.jsonl'));

// ─── Layer 2: Agent Runtime ─────────────────────────────────

log.info('Initializing Agent Runtime...');
loadSoul();
loadMemory();
loadSkills();

// ─── Recover incomplete executions from previous runs ───────

const sendMessageRef = { fn: null };

await recoverIncompleteExecutions((chatId, text) => {
    if (sendMessageRef.fn) return sendMessageRef.fn(chatId, text);
});

// ─── Layer 4: Scheduler ─────────────────────────────────────

if (getConfig('scheduler.enabled', true)) {
    log.info('Initializing Scheduler...');

    setJobTriggerCallback(async (task) => {
        log.info({ taskId: task.id, taskName: task.name, taskType: task.task_type }, 'Proactive task triggered');

        // Build a synthetic message for the orchestrator
        const syntheticMsg = {
            id: `scheduled-${task.id}-${Date.now()}`,
            platform: 'system',
            user_id: task.user_id,
            chat_id: task.chat_id,
            chat_type: 'private',
            timestamp: new Date().toISOString(),
            message: `[SCHEDULED TASK: ${task.name}] ${JSON.stringify(task.config)}`,
        };

        try {
            const response = await handleMessage(syntheticMsg, sendMessageRef.fn || (() => { }));
            if (response && sendMessageRef.fn) {
                await sendMessageRef.fn(task.chat_id, `🔔 **Scheduled: ${task.name}**\n\n${response}`);
            }
        } catch (err) {
            log.error({ err, taskId: task.id }, 'Scheduled task execution failed');
        }
    });

    loadScheduledTasks();
}

// ─── Layer 1: Messaging Gateway ─────────────────────────────

log.info('Initializing Messaging Gateway...');
const bot = initTelegram();
sendMessageRef.fn = getSendMessage();
await startTelegram();

log.info('═══════════════════════════════════════════');
log.info('  Aatman Gateway — ONLINE');
log.info('═══════════════════════════════════════════');

// ─── Graceful Shutdown ──────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'Shutting down gracefully...');

    try {
        // Stop gateway first (no new messages)
        await stopTelegram();
        log.info('Gateway stopped');

        // Stop scheduler
        stopAllJobs();
        log.info('Scheduler stopped');

        // Close audit log
        await closeAuditLog();
        log.info('Audit log closed');

        // Close database last
        closeDatabase();
        log.info('Database closed');

        log.info('Shutdown complete.');
        process.exit(0);
    } catch (err) {
        log.error({ err }, 'Error during shutdown');
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'Unhandled rejection');
    shutdown('unhandledRejection');
});
