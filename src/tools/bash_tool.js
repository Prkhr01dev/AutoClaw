// src/tools/bash_tool.js — Hardened shell execution with destructive command detection
import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';
import { getConfig } from '../utils/config.js';

const log = createLogger('bash_tool');

/**
 * Patterns that indicate potentially destructive commands requiring HITL confirmation.
 */
const DESTRUCTIVE_PATTERNS = [
    /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)\b/,
    /\brm\s+-rf\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\binit\s+[0-6]\b/,
    /\bmkfs\b/,
    /\bdd\s+.*of=/,
    /\bformat\b/,
    /\bcurl\s+.*\|\s*(sh|bash|zsh)\b/,
    /\bwget\s+.*\|\s*(sh|bash|zsh)\b/,
    /\bdocker\s+(rm|rmi|stop|kill|prune|system\s+prune)\b/,
    /\biptables\b/,
    /\bufw\b/,
    /\bsystemctl\s+(stop|disable|mask)\b/,
    /\bchmod\s+[0-7]*777\b/,
    /\bchown\s+-R\b/,
    />\s*\/dev\/sd[a-z]/,
    /\bkill\s+-9\b/,
    /\bkillall\b/,
    /\bpkill\b/,
    /\bnohup\b.*&$/,
];

/**
 * Environment variables to strip from child process environment.
 */
const BLOCKED_ENV_PATTERNS = [
    /API_KEY/i, /SECRET/i, /TOKEN/i, /PASSWORD/i, /PRIVATE_KEY/i,
    /AWS_/i, /AZURE_/i, /GCP_/i, /ANTHROPIC/i, /OPENAI/i,
];

/**
 * Check if a command matches any destructive pattern.
 * @param {string} command
 * @returns {{ isDestructive: boolean, matchedPattern: string|null }}
 */
export function detectDestructiveCommand(command) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
        if (pattern.test(command)) {
            return { isDestructive: true, matchedPattern: pattern.toString() };
        }
    }
    return { isDestructive: false, matchedPattern: null };
}

/**
 * Build a sanitized environment for the child process.
 */
function sanitizedEnv() {
    const env = { ...process.env };
    const blockedKeys = getConfig('tools.bash.blockedEnvVars', []);

    for (const key of Object.keys(env)) {
        // Check against config-specified blocked vars
        if (blockedKeys.some((b) => key.toUpperCase().includes(b.toUpperCase()))) {
            delete env[key];
            continue;
        }
        // Check against pattern-based blocked vars
        if (BLOCKED_ENV_PATTERNS.some((p) => p.test(key))) {
            delete env[key];
        }
    }

    return env;
}

/**
 * Execute a bash command with timeout, sanitization, and destructive command detection.
 * @param {Object} params
 * @param {string} params.command - Shell command to execute
 * @param {string} [params.cwd] - Working directory (defaults to workspace root)
 * @param {number} [params.timeoutMs] - Override timeout
 * @param {Object} context
 * @param {string} context.userId
 * @param {string} context.chatId
 * @param {boolean} context.isSandbox - If true, bash is entirely disabled
 * @returns {Promise<Object>}
 */
export async function executeBashTool(params, context) {
    const { command, cwd } = params;
    const { userId, chatId, isSandbox } = context;
    const timeoutMs = params.timeoutMs || getConfig('tools.bash.timeoutMs', 30000);
    const maxOutputBytes = getConfig('tools.bash.maxOutputBytes', 1048576);

    // Sandbox mode: bash entirely disabled
    if (isSandbox) {
        const msg = 'bash_tool is disabled in sandbox (group chat) mode';
        audit({ action: 'bash_tool', tool: 'bash', userId, chatId, params: { command }, status: 'blocked', error: msg });
        return { success: false, error: msg, requiresConfirmation: false };
    }

    // Check for destructive commands
    const { isDestructive, matchedPattern } = detectDestructiveCommand(command);
    if (isDestructive) {
        log.warn({ command, matchedPattern }, 'Destructive command detected — requires HITL confirmation');
        audit({ action: 'bash_tool', tool: 'bash', userId, chatId, params: { command }, status: 'awaiting_confirmation', error: `Destructive pattern: ${matchedPattern}` });
        return {
            success: false,
            requiresConfirmation: true,
            reason: `Destructive command detected (${matchedPattern}). User confirmation required.`,
            command,
        };
    }

    // Execute command
    return new Promise((resolvePromise) => {
        const workDir = cwd || getConfig('tools.fs.rootDir', '/data/workspace');
        let stdout = '';
        let stderr = '';
        let killed = false;

        const child = spawn('sh', ['-c', command], {
            cwd: workDir,
            env: sanitizedEnv(),
            timeout: timeoutMs,
            maxBuffer: maxOutputBytes,
        });

        const timeoutHandle = setTimeout(() => {
            killed = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            if (stdout.length + chunk.length <= maxOutputBytes) {
                stdout += chunk;
            }
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            if (stderr.length + chunk.length <= maxOutputBytes) {
                stderr += chunk;
            }
        });

        child.on('close', (code) => {
            clearTimeout(timeoutHandle);
            const result = {
                success: code === 0,
                exitCode: code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                killed,
                timedOut: killed,
            };

            audit({ action: 'bash_tool', tool: 'bash', userId, chatId, params: { command, cwd: workDir }, result: { exitCode: code, killed }, status: code === 0 ? 'success' : 'error' });
            log.info({ command: command.slice(0, 100), exitCode: code, killed }, 'bash_tool executed');

            resolvePromise(result);
        });

        child.on('error', (err) => {
            clearTimeout(timeoutHandle);
            const result = { success: false, error: err.message, exitCode: null };
            audit({ action: 'bash_tool', tool: 'bash', userId, chatId, params: { command }, status: 'error', error: err.message });
            log.error({ err, command: command.slice(0, 100) }, 'bash_tool spawn error');
            resolvePromise(result);
        });
    });
}

/** Tool schema for LLM context */
export const bashTool = {
    name: 'bash_tool',
    description: 'Execute a shell command with timeout enforcement and safety checks. Destructive commands (rm -rf, shutdown, docker controls, etc.) require user confirmation. Disabled in group chats.',
    parameters: {
        command: { type: 'string', description: 'Shell command to execute', required: true },
        cwd: { type: 'string', description: 'Working directory (optional, defaults to workspace root)' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (optional)' },
    },
};
