// src/tools/tool-registry.js — Central tool registry with permission enforcement
import { executeFsTool, fsTool } from './fs_tool.js';
import { executeBashTool, bashTool } from './bash_tool.js';
import { executeBrowserTool, browserToolSchema } from './browser_tool.js';
import { requestConfirmation, getPendingConfirmations } from './hitl.js';
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';

const log = createLogger('tool-registry');

/** Tool definitions with executors and permission levels */
const tools = new Map([
    ['fs_tool', {
        schema: fsTool,
        execute: executeFsTool,
        allowInSandbox: true, // read-only ops still work
        isAsync: false,
    }],
    ['bash_tool', {
        schema: bashTool,
        execute: executeBashTool,
        allowInSandbox: false, // entirely blocked in group chats
        isAsync: true,
    }],
    ['browser_tool', {
        schema: browserToolSchema,
        execute: executeBrowserTool,
        allowInSandbox: true, // read-only browsing allowed
        isAsync: true,
    }],
]);

/**
 * Execute a tool by name with permission enforcement.
 * @param {string} toolName
 * @param {Object} params - Tool-specific parameters
 * @param {Object} context
 * @param {string} context.userId
 * @param {string} context.chatId
 * @param {string} context.chatType - "private" or "group"
 * @param {Function} context.sendMessage - For HITL confirmations
 * @returns {Promise<Object>} Tool execution result
 */
export async function executeTool(toolName, params, context) {
    const tool = tools.get(toolName);

    if (!tool) {
        const error = `Unknown tool: ${toolName}`;
        log.warn({ toolName }, error);
        return { success: false, error };
    }

    const isSandbox = context.chatType === 'group';

    // Check sandbox permissions
    if (isSandbox && !tool.allowInSandbox) {
        const msg = `Tool "${toolName}" is not available in group chat sandbox mode`;
        audit({ action: 'tool_blocked', tool: toolName, userId: context.userId, chatId: context.chatId, status: 'blocked', error: msg });
        return { success: false, error: msg };
    }

    const execContext = { ...context, isSandbox };

    try {
        let result;

        if (tool.isAsync) {
            result = await tool.execute(params, execContext);
        } else {
            result = tool.execute(params, execContext);
        }

        // Handle HITL confirmation flow
        if (result.requiresConfirmation && context.sendMessage) {
            log.info({ toolName, params }, 'Tool requires HITL confirmation');
            const approved = await requestConfirmation({
                chatId: context.chatId,
                userId: context.userId,
                tool: toolName,
                action: result.reason || `Execute ${toolName}`,
                params,
                sendMessage: context.sendMessage,
            });

            if (approved) {
                log.info({ toolName }, 'HITL approved — re-executing');
                // Re-execute without destructive check (directly via spawn)
                // For bash_tool, we need to bypass the detection
                result = await executeBashToolForced(params, execContext);
            } else {
                return { success: false, error: 'Action denied by user', denied: true };
            }
        }

        return result;
    } catch (err) {
        log.error({ err, toolName }, 'Tool execution error');
        return { success: false, error: err.message };
    }
}

/**
 * Force-execute bash command after HITL approval (bypasses destructive detection).
 */
async function executeBashToolForced(params, context) {
    const { spawn } = await import('node:child_process');
    const { getConfig } = await import('../utils/config.js');

    const { command, cwd } = params;
    const timeoutMs = params.timeoutMs || getConfig('tools.bash.timeoutMs', 30000);
    const workDir = cwd || getConfig('tools.fs.rootDir', '/data/workspace');

    return new Promise((resolve) => {
        let stdout = '', stderr = '', killed = false;

        const child = spawn('sh', ['-c', command], {
            cwd: workDir,
            timeout: timeoutMs,
        });

        const timeoutHandle = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
            clearTimeout(timeoutHandle);
            audit({ action: 'bash_tool_forced', tool: 'bash', userId: context.userId, chatId: context.chatId, params: { command }, result: { exitCode: code }, status: code === 0 ? 'success' : 'error' });
            resolve({ success: code === 0, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim(), killed });
        });

        child.on('error', (err) => {
            clearTimeout(timeoutHandle);
            resolve({ success: false, error: err.message });
        });
    });
}

/**
 * Get all tool schemas for LLM context injection.
 */
export function getToolSchemas(chatType = 'private') {
    const schemas = [];
    for (const [name, tool] of tools) {
        if (chatType === 'group' && !tool.allowInSandbox) continue;
        schemas.push(tool.schema);
    }
    return schemas;
}

/**
 * Get tool names.
 */
export function getToolNames() {
    return [...tools.keys()];
}
