// src/runtime/skill-loader.js — Dynamic skill injection from /skills directory
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('skill-loader');

/** @type {Array<{name: string, description: string, triggers: string[], content: string}>} */
let skills = [];

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Simple parser — supports name, description, and triggers list.
 */
function parseFrontmatter(content) {
    const fmRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(fmRegex);
    if (!match) return { metadata: {}, body: content };

    const rawMeta = match[1];
    const body = match[2];
    const metadata = {};

    for (const line of rawMeta.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();

        // Handle triggers array
        if (key === 'triggers' && value === '') {
            // Multi-line list format
            continue;
        }

        metadata[key] = value;
    }

    // Parse multi-line triggers
    const triggerLines = rawMeta.split('\n').filter((l) => l.trim().startsWith('- '));
    if (triggerLines.length > 0) {
        metadata.triggers = triggerLines.map((l) => l.trim().replace(/^- /, ''));
    }

    return { metadata, body };
}

/**
 * Scan and load all markdown skills from the skills directory.
 * @param {string} [skillsDir] - Path to skills directory (default: data/skills)
 */
export function loadSkills(skillsDir) {
    const dir = skillsDir || resolve(process.cwd(), 'data', 'skills');

    if (!existsSync(dir)) {
        log.info({ dir }, 'Skills directory not found — no skills loaded');
        return [];
    }

    skills = [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
        try {
            const content = readFileSync(join(dir, file), 'utf-8');
            const { metadata, body } = parseFrontmatter(content);

            skills.push({
                name: metadata.name || file.replace('.md', ''),
                description: metadata.description || '',
                triggers: metadata.triggers || [],
                content: body,
                filename: file,
            });

            log.debug({ file, name: metadata.name, triggers: metadata.triggers }, 'Skill loaded');
        } catch (err) {
            log.warn({ err, file }, 'Failed to load skill');
        }
    }

    log.info({ count: skills.length, dir }, 'Skills loaded');
    return skills;
}

/**
 * Find skills relevant to a user message.
 * Matches against trigger keywords.
 * @param {string} message - The user message to match against
 * @returns {Array<{name: string, content: string}>} Matching skills
 */
export function matchSkills(message) {
    const lower = message.toLowerCase();

    return skills.filter((skill) => {
        // Check triggers
        if (skill.triggers.some((t) => lower.includes(t.toLowerCase()))) {
            return true;
        }
        // Check skill name
        if (lower.includes(skill.name.toLowerCase())) {
            return true;
        }
        return false;
    });
}

/**
 * Get all loaded skills.
 */
export function getAllSkills() {
    return skills;
}

/**
 * Reload skills from disk (hot-reload support).
 */
export function reloadSkills(skillsDir) {
    log.info('Reloading skills...');
    return loadSkills(skillsDir);
}
