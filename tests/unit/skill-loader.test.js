// tests/unit/skill-loader.test.js — Skill loading and matching tests
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const testSkillsDir = resolve(process.cwd(), 'tests', '_test_skills');

before(() => {
    mkdirSync(testSkillsDir, { recursive: true });

    writeFileSync(join(testSkillsDir, 'deploy.md'), `---
name: deploy_app
description: Deploy the application to production
triggers:
  - deploy
  - ship
  - release
---

# Deploy Skill

1. Run tests
2. Build the project
3. Push to production
`);

    writeFileSync(join(testSkillsDir, 'backup.md'), `---
name: backup_data
description: Create a backup of project data
triggers:
  - backup
  - save data
---

# Backup Skill

1. Compress the data directory
2. Copy to backup location
`);
});

after(() => {
    if (existsSync(testSkillsDir)) {
        rmSync(testSkillsDir, { recursive: true, force: true });
    }
});

describe('Skill Loader', () => {
    it('should load skills from directory', async () => {
        const { loadSkills } = await import('../../src/runtime/skill-loader.js');
        const skills = loadSkills(testSkillsDir);
        assert.equal(skills.length, 2);
    });

    it('should parse frontmatter correctly', async () => {
        const { loadSkills, getAllSkills } = await import('../../src/runtime/skill-loader.js');
        loadSkills(testSkillsDir);
        const skills = getAllSkills();
        const deploy = skills.find(s => s.name === 'deploy_app');
        assert.ok(deploy);
        assert.ok(deploy.triggers.includes('deploy'));
        assert.ok(deploy.triggers.includes('ship'));
        assert.ok(deploy.content.includes('Deploy Skill'));
    });

    it('should match skills by trigger keywords', async () => {
        const { loadSkills, matchSkills } = await import('../../src/runtime/skill-loader.js');
        loadSkills(testSkillsDir);

        const deployMatches = matchSkills('Please deploy the app to production');
        assert.ok(deployMatches.length > 0);
        assert.equal(deployMatches[0].name, 'deploy_app');

        const backupMatches = matchSkills('Can you backup my data?');
        assert.ok(backupMatches.length > 0);
        assert.equal(backupMatches[0].name, 'backup_data');
    });

    it('should return empty for non-matching messages', async () => {
        const { loadSkills, matchSkills } = await import('../../src/runtime/skill-loader.js');
        loadSkills(testSkillsDir);

        const matches = matchSkills('What is the weather today?');
        assert.equal(matches.length, 0);
    });
});
