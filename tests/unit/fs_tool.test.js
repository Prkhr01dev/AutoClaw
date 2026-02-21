// tests/unit/fs_tool.test.js — Filesystem tool security and correctness tests
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Setup config and deps before importing fs_tool
const testRoot = resolve(process.cwd(), 'tests', '_test_workspace');

before(async () => {
    mkdirSync(testRoot, { recursive: true });

    // Mock config
    const { loadConfig } = await import('../../src/utils/config.js');
    // We need to set up a minimal config for tools.fs.rootDir
    const { writeFileSync } = await import('node:fs');
    const configPath = resolve(process.cwd(), 'tests', '_test_config.json');
    writeFileSync(configPath, JSON.stringify({
        tools: { fs: { rootDir: testRoot, maxFileSizeBytes: 1024 } },
        logging: { level: 'silent' },
    }));
    loadConfig(configPath);
});

after(() => {
    if (existsSync(testRoot)) {
        rmSync(testRoot, { recursive: true, force: true });
    }
    const configPath = resolve(process.cwd(), 'tests', '_test_config.json');
    if (existsSync(configPath)) rmSync(configPath);
});

describe('fs_tool', () => {
    it('should write and read a file', async () => {
        const { executeFsTool } = await import('../../src/tools/fs_tool.js');
        const ctx = { userId: 'test', chatId: 'test', isSandbox: false };

        const writeResult = executeFsTool({ action: 'write', path: 'test.txt', content: 'Hello World' }, ctx);
        assert.equal(writeResult.success, true);

        const readResult = executeFsTool({ action: 'read', path: 'test.txt' }, ctx);
        assert.equal(readResult.success, true);
        assert.equal(readResult.content, 'Hello World');
    });

    it('should block path traversal', async () => {
        const { executeFsTool } = await import('../../src/tools/fs_tool.js');
        const ctx = { userId: 'test', chatId: 'test', isSandbox: false };

        const result = executeFsTool({ action: 'read', path: '../../../etc/passwd' }, ctx);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('traversal'));
    });

    it('should block writes in sandbox mode', async () => {
        const { executeFsTool } = await import('../../src/tools/fs_tool.js');
        const ctx = { userId: 'test', chatId: 'test', isSandbox: true };

        const result = executeFsTool({ action: 'write', path: 'test.txt', content: 'hack' }, ctx);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('sandbox'));
    });

    it('should allow reads in sandbox mode', async () => {
        const { executeFsTool } = await import('../../src/tools/fs_tool.js');
        const ctx = { userId: 'test', chatId: 'test', isSandbox: true };

        const result = executeFsTool({ action: 'exists', path: 'test.txt' }, ctx);
        assert.equal(result.success, true);
    });

    it('should list directory contents', async () => {
        const { executeFsTool } = await import('../../src/tools/fs_tool.js');
        const ctx = { userId: 'test', chatId: 'test', isSandbox: false };

        const result = executeFsTool({ action: 'list', path: '.' }, ctx);
        assert.equal(result.success, true);
        assert.ok(Array.isArray(result.entries));
    });
});
