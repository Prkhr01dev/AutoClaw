// src/runtime/memory-manager.js — MEMORY.md read/write + fact management
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';

const log = createLogger('memory-manager');

let memoryPath = null;
let memoryContent = null;

/**
 * Load MEMORY.md from disk.
 * @param {string} [path] - Custom path (default: data/MEMORY.md)
 */
export function loadMemory(path) {
    memoryPath = path || resolve(process.cwd(), 'data', 'MEMORY.md');
    if (existsSync(memoryPath)) {
        memoryContent = readFileSync(memoryPath, 'utf-8');
        log.info({ path: memoryPath }, 'MEMORY.md loaded');
    } else {
        memoryContent = '# MEMORY — Aatman Long-Term Memory\n\n## User Preferences\n\n## Learned Facts\n\n## Project Context\n';
        saveMemory();
        log.info({ path: memoryPath }, 'MEMORY.md created (new)');
    }
    return memoryContent;
}

/**
 * Atomically save MEMORY.md to disk.
 */
function saveMemory() {
    if (!memoryPath) return;

    const dir = dirname(memoryPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Atomic write
    const tmpPath = join(dir, `.tmp-memory-${randomUUID()}`);
    writeFileSync(tmpPath, memoryContent, 'utf-8');
    renameSync(tmpPath, memoryPath);
}

/**
 * Get the current memory content.
 */
export function getMemory() {
    if (!memoryContent) loadMemory();
    return memoryContent;
}

/**
 * Add a fact to a specific category in MEMORY.md.
 * @param {string} category - One of "User Preferences", "Learned Facts", "Project Context"
 * @param {string} fact - The fact to add
 */
export function addFact(category, fact) {
    if (!memoryContent) loadMemory();

    const timestamp = new Date().toISOString().split('T')[0]; // Date only
    const entry = `- [${timestamp}] ${fact}`;

    const sectionRegex = new RegExp(`(## ${escapeRegex(category)}\\n)([\\s\\S]*?)(?=\\n## |$)`, 'm');
    const match = memoryContent.match(sectionRegex);

    if (match) {
        const sectionContent = match[2].trim();
        const cleanedSection = sectionContent.replace(/^_No .+yet\._$/m, '').trim();
        const newSection = cleanedSection ? `${cleanedSection}\n${entry}` : entry;
        memoryContent = memoryContent.replace(sectionRegex, `$1${newSection}\n\n`);
    } else {
        // Section doesn't exist, append it
        memoryContent += `\n## ${category}\n${entry}\n`;
    }

    saveMemory();
    audit({ action: 'memory_update', params: { category, fact }, status: 'success' });
    log.info({ category, fact: fact.slice(0, 80) }, 'Fact added to memory');
}

/**
 * Search memory for a query (simple substring match).
 * For semantic search, use the embeddings module.
 * @param {string} query
 * @returns {string[]} Matching lines
 */
export function searchFacts(query) {
    if (!memoryContent) loadMemory();
    const lower = query.toLowerCase();
    return memoryContent
        .split('\n')
        .filter((line) => line.startsWith('- ') && line.toLowerCase().includes(lower));
}

/**
 * Get all facts from a specific category.
 */
export function getFactsByCategory(category) {
    if (!memoryContent) loadMemory();

    const sectionRegex = new RegExp(`## ${escapeRegex(category)}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
    const match = memoryContent.match(sectionRegex);

    if (!match) return [];
    return match[1]
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.replace(/^- (\[[\d-]+\] )?/, ''));
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
