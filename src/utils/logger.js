// src/utils/logger.js — Structured logging with pino
import pino from 'pino';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let baseLogger = null;

/**
 * Initialize the base logger. Call once at startup.
 */
export function initLogger(level = 'info') {
    baseLogger = pino({
        level,
        formatters: {
            level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: pino.stdSerializers,
    });
    return baseLogger;
}

/**
 * Create a child logger with a component name.
 * @param {string} component - Name of the component
 */
export function createLogger(component) {
    if (!baseLogger) {
        // Auto-init with default level for early usage
        initLogger('info');
    }
    return baseLogger.child({ component });
}

/**
 * Get the base logger instance.
 */
export function getLogger() {
    if (!baseLogger) initLogger('info');
    return baseLogger;
}
