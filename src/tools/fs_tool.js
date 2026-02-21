// src/tools/fs_tool.js — Sandboxed filesystem operations with audit logging
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';
import { getConfig } from '../utils/config.js';

const log = createLogger('fs_tool');

/**
 * Resolve and validate a path is within the sandbox root.
 * Prevents path traversal attacks.
 */
function safePath(userPath, rootDir) {
    const root = resolve(rootDir);
    const target = resolve(root, userPath);

    if (!target.startsWith(root)) {
        throw new Error(`Path traversal blocked: "${userPath}" escapes sandbox root`);
    }

    return target;
}

/**
 * Execute a filesystem operation.
 * @param {Object} params
 * @param {string} params.action - "read" | "write" | "list" | "mkdir" | "delete" | "exists" | "stat"
 * @param {string} params.path - Relative path within the sandbox
 * @param {string} [params.content] - Content for write operations
 * @param {Object} context - Execution context
 * @param {string} context.userId
 * @param {string} context.chatId
 * @param {boolean} context.isSandbox - If true, writes are blocked
 */
export function executeFsTool(params, context) {
    const rootDir = getConfig('tools.fs.rootDir', '/data/workspace');
    const maxFileSize = getConfig('tools.fs.maxFileSizeBytes', 10485760); // 10MB
    const { action, path: userPath, content } = params;
    const { userId, chatId, isSandbox } = context;

    // Validate path
    const targetPath = safePath(userPath, rootDir);

    // Sandbox mode: block write operations
    if (isSandbox && ['write', 'mkdir', 'delete'].includes(action)) {
        const msg = `Operation "${action}" blocked in sandbox (group chat) mode`;
        audit({ action: 'fs_tool', tool: 'fs', userId, chatId, params: { action, path: userPath }, status: 'blocked', error: msg });
        return { success: false, error: msg };
    }

    try {
        let result;

        switch (action) {
            case 'read': {
                if (!existsSync(targetPath)) {
                    throw new Error(`File not found: ${userPath}`);
                }
                const stat = statSync(targetPath);
                if (stat.size > maxFileSize) {
                    throw new Error(`File too large: ${stat.size} bytes (max: ${maxFileSize})`);
                }
                result = { content: readFileSync(targetPath, 'utf-8'), size: stat.size };
                break;
            }

            case 'write': {
                if (content === undefined || content === null) {
                    throw new Error('No content provided for write operation');
                }
                const contentBytes = Buffer.byteLength(content, 'utf-8');
                if (contentBytes > maxFileSize) {
                    throw new Error(`Content too large: ${contentBytes} bytes (max: ${maxFileSize})`);
                }

                // Atomic write: write to temp, then rename
                const dir = dirname(targetPath);
                if (!existsSync(dir)) {
                    mkdirSync(dir, { recursive: true });
                }
                const tmpPath = join(dir, `.tmp-${randomUUID()}`);
                writeFileSync(tmpPath, content, 'utf-8');
                renameSync(tmpPath, targetPath);

                result = { written: contentBytes, path: userPath };
                break;
            }

            case 'list': {
                if (!existsSync(targetPath)) {
                    throw new Error(`Directory not found: ${userPath}`);
                }
                const entries = readdirSync(targetPath, { withFileTypes: true });
                result = {
                    entries: entries.map((e) => ({
                        name: e.name,
                        type: e.isDirectory() ? 'directory' : 'file',
                    })),
                };
                break;
            }

            case 'mkdir': {
                mkdirSync(targetPath, { recursive: true });
                result = { created: userPath };
                break;
            }

            case 'delete': {
                if (!existsSync(targetPath)) {
                    throw new Error(`File not found: ${userPath}`);
                }
                const stat = statSync(targetPath);
                if (stat.isDirectory()) {
                    throw new Error('Cannot delete directories via fs_tool for safety. Use bash_tool with confirmation.');
                }
                unlinkSync(targetPath);
                result = { deleted: userPath };
                break;
            }

            case 'exists': {
                result = { exists: existsSync(targetPath) };
                break;
            }

            case 'stat': {
                if (!existsSync(targetPath)) {
                    throw new Error(`Path not found: ${userPath}`);
                }
                const stat = statSync(targetPath);
                result = {
                    size: stat.size,
                    isDirectory: stat.isDirectory(),
                    isFile: stat.isFile(),
                    modified: stat.mtime.toISOString(),
                    created: stat.birthtime.toISOString(),
                };
                break;
            }

            default:
                throw new Error(`Unknown fs_tool action: ${action}`);
        }

        audit({ action: 'fs_tool', tool: 'fs', userId, chatId, params: { action, path: userPath }, result, status: 'success' });
        log.info({ action, path: userPath }, 'fs_tool executed');
        return { success: true, ...result };
    } catch (err) {
        audit({ action: 'fs_tool', tool: 'fs', userId, chatId, params: { action, path: userPath }, status: 'error', error: err.message });
        log.error({ err, action, path: userPath }, 'fs_tool error');
        return { success: false, error: err.message };
    }
}

/** Tool schema for LLM context */
export const fsTool = {
    name: 'fs_tool',
    description: 'Perform filesystem operations within the sandboxed workspace. Supports: read, write (atomic), list, mkdir, delete (files only), exists, stat.',
    parameters: {
        action: { type: 'string', enum: ['read', 'write', 'list', 'mkdir', 'delete', 'exists', 'stat'], required: true },
        path: { type: 'string', description: 'Relative path within workspace', required: true },
        content: { type: 'string', description: 'Content for write operations' },
    },
};
