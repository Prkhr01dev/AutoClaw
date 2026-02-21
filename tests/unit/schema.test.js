// tests/unit/schema.test.js — Message schema validation tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, validateResponse } from '../../src/gateway/schema.js';

describe('NormalizedMessage Schema', () => {
    it('should accept a valid message', () => {
        const result = validateMessage({
            id: '123',
            platform: 'telegram',
            user_id: '456',
            chat_id: '789',
            chat_type: 'private',
            timestamp: '2025-01-01T00:00:00.000Z',
            message: 'Hello',
        });
        assert.equal(result.success, true);
    });

    it('should reject missing fields', () => {
        const result = validateMessage({ id: '123' });
        assert.equal(result.success, false);
        assert.ok(result.error.includes('platform'));
    });

    it('should reject invalid platform', () => {
        const result = validateMessage({
            id: '123',
            platform: 'discord',
            user_id: '456',
            chat_id: '789',
            chat_type: 'private',
            timestamp: '2025-01-01T00:00:00.000Z',
            message: 'Hello',
        });
        assert.equal(result.success, false);
    });

    it('should reject empty message', () => {
        const result = validateMessage({
            id: '123',
            platform: 'telegram',
            user_id: '456',
            chat_id: '789',
            chat_type: 'private',
            timestamp: '2025-01-01T00:00:00.000Z',
            message: '',
        });
        assert.equal(result.success, false);
    });

    it('should accept group chat type', () => {
        const result = validateMessage({
            id: '123',
            platform: 'telegram',
            user_id: '456',
            chat_id: '789',
            chat_type: 'group',
            timestamp: '2025-01-01T00:00:00.000Z',
            message: 'Hi group',
        });
        assert.equal(result.success, true);
    });
});

describe('AgentResponse Schema', () => {
    it('should accept a valid response', () => {
        const result = validateResponse({
            chat_id: '789',
            text: 'Hello back!',
        });
        assert.equal(result.success, true);
    });

    it('should accept response with parse_mode', () => {
        const result = validateResponse({
            chat_id: '789',
            text: '**Bold**',
            parse_mode: 'Markdown',
        });
        assert.equal(result.success, true);
    });

    it('should reject empty text', () => {
        const result = validateResponse({
            chat_id: '789',
            text: '',
        });
        assert.equal(result.success, false);
    });
});
