// src/utils/config.js — Configuration loader
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('config');

let config = null;

/**
 * Load configuration from config.json.
 * @param {string} [configPath] - Path to config file (default: project root config.json)
 */
export function loadConfig(configPath) {
    const path = configPath || resolve(process.cwd(), 'config.json');
    try {
        const raw = readFileSync(path, 'utf-8');
        config = JSON.parse(raw);
        log.info({ path }, 'Configuration loaded');
        return config;
    } catch (err) {
        log.error({ err, path }, 'Failed to load configuration');
        throw new Error(`Cannot load config from ${path}: ${err.message}`);
    }
}

/**
 * Get a nested config value by dot-notation path.
 * @param {string} key - Dot-notation key (e.g., "llm.provider")
 * @param {*} [defaultValue] - Default if key not found
 */
export function getConfig(key, defaultValue) {
    if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
    const parts = key.split('.');
    let value = config;
    for (const part of parts) {
        if (value == null || typeof value !== 'object') return defaultValue;
        value = value[part];
    }
    return value !== undefined ? value : defaultValue;
}

/** Get the full config object. */
export function getFullConfig() {
    if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
    return config;
}
