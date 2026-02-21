// src/memory/database.js — SQLite + sqlite-vec initialization
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('database');

let db = null;

/**
 * Initialize SQLite database with WAL mode and sqlite-vec extension.
 * Creates all required tables if they don't exist.
 */
export function initDatabase(dbPath) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Performance settings
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Load sqlite-vec extension
  try {
    sqliteVec.load(db);
    log.info('sqlite-vec extension loaded successfully');
  } catch (err) {
    log.warn({ err }, 'sqlite-vec extension failed to load — semantic search disabled');
  }

  // Create schema
  db.exec(`
    -- Conversation history
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_chat
      ON conversations(chat_id, timestamp);

    -- Execution state for restart recovery
    CREATE TABLE IF NOT EXISTS execution_state (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step INTEGER NOT NULL DEFAULT 0,
      observations TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_execution_status
      ON execution_state(status);

    -- HITL pending confirmations
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      tool TEXT NOT NULL,
      params TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_status
      ON pending_confirmations(status, chat_id);

    -- Scheduled tasks
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      task_type TEXT NOT NULL,
      config TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_enabled
      ON scheduled_tasks(enabled);
  `);

  // Create vector table for embeddings if sqlite-vec is available
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        id TEXT PRIMARY KEY,
        content_embedding FLOAT[384]
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_metadata (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        chat_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    log.info('Vector embedding tables initialized');
  } catch (err) {
    log.warn({ err }, 'Vector tables could not be created — semantic search disabled');
  }

  log.info({ dbPath }, 'Database initialized');
  return db;
}

/** Get the database instance. Throws if not initialized. */
export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

/** Gracefully close the database. */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
}
