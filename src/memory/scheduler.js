// src/memory/scheduler.js — Persistent cron-based job scheduler
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './database.js';
import { createLogger } from '../utils/logger.js';
import { audit } from './audit-log.js';

const log = createLogger('scheduler');

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const activeJobs = new Map();

/** @type {Function|null} Callback for when a job triggers */
let onJobTrigger = null;

/**
 * Set the callback that fires when a scheduled job triggers.
 * @param {Function} callback - (task: Object) => Promise<void>
 */
export function setJobTriggerCallback(callback) {
    onJobTrigger = callback;
}

/**
 * Load all enabled scheduled tasks from the database and start them.
 */
export function loadScheduledTasks() {
    const db = getDb();
    const tasks = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all();

    for (const task of tasks) {
        startCronJob(task);
    }

    log.info({ count: tasks.length }, 'Scheduled tasks loaded from database');
}

/**
 * Create and persist a new scheduled task.
 * @param {Object} opts
 * @param {string} opts.name - Human-readable name
 * @param {string} opts.cronExpression - Cron expression (e.g., "0 * * * *")
 * @param {string} opts.taskType - Type: "url_check", "api_poll", "file_watch", "custom"
 * @param {Object} opts.config - Task-specific configuration
 * @param {string} opts.chatId - Chat to send results to
 * @param {string} opts.userId - User who created the task
 * @returns {string} Task ID
 */
export function createScheduledTask({ name, cronExpression, taskType, config, chatId, userId }) {
    if (!cron.validate(cronExpression)) {
        throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    const db = getDb();
    const id = uuidv4();

    db.prepare(`
    INSERT INTO scheduled_tasks (id, name, cron_expression, task_type, config, chat_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, cronExpression, taskType, JSON.stringify(config), chatId, userId);

    const task = { id, name, cron_expression: cronExpression, task_type: taskType, config: JSON.stringify(config), chat_id: chatId, user_id: userId, enabled: 1 };
    startCronJob(task);

    audit({ action: 'scheduled_task_create', params: { id, name, cronExpression, taskType }, userId, chatId });
    log.info({ id, name, cronExpression }, 'Scheduled task created');

    return id;
}

/**
 * Start a cron job for a task record.
 */
function startCronJob(task) {
    if (activeJobs.has(task.id)) {
        activeJobs.get(task.id).stop();
    }

    const job = cron.schedule(task.cron_expression, async () => {
        log.info({ taskId: task.id, name: task.name }, 'Scheduled task triggered');
        audit({ action: 'scheduled_task_trigger', params: { taskId: task.id, name: task.name } });

        // Update last_run
        try {
            getDb().prepare('UPDATE scheduled_tasks SET last_run = datetime(\'now\') WHERE id = ?').run(task.id);
        } catch (err) {
            log.error({ err, taskId: task.id }, 'Failed to update last_run');
        }

        if (onJobTrigger) {
            try {
                const config = typeof task.config === 'string' ? JSON.parse(task.config) : task.config;
                await onJobTrigger({ ...task, config });
            } catch (err) {
                log.error({ err, taskId: task.id }, 'Job trigger callback failed');
            }
        }
    });

    activeJobs.set(task.id, job);
}

/**
 * Delete a scheduled task by ID.
 */
export function deleteScheduledTask(id) {
    const db = getDb();
    if (activeJobs.has(id)) {
        activeJobs.get(id).stop();
        activeJobs.delete(id);
    }
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
    audit({ action: 'scheduled_task_delete', params: { id } });
    log.info({ id }, 'Scheduled task deleted');
}

/**
 * List all scheduled tasks.
 */
export function listScheduledTasks() {
    return getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all();
}

/**
 * Stop all active cron jobs.
 */
export function stopAllJobs() {
    for (const [id, job] of activeJobs) {
        job.stop();
        log.debug({ id }, 'Cron job stopped');
    }
    activeJobs.clear();
    log.info('All scheduled jobs stopped');
}
