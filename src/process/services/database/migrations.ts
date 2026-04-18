/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ISqliteDriver } from './drivers/ISqliteDriver';

/**
 * Migration script definition
 */
export interface IMigration {
  version: number; // Target version after this migration
  name: string; // Migration name for logging
  up: (db: ISqliteDriver) => void; // Upgrade script
  down: (db: ISqliteDriver) => void; // Downgrade script (for rollback)
}

/**
 * Migration v0 -> v1: Initial schema
 * This is handled by initSchema() in schema.ts
 */
const migration_v1: IMigration = {
  version: 1,
  name: 'Initial schema',
  up: (_db) => {
    // Already handled by initSchema()
    console.log('[Migration v1] Initial schema created by initSchema()');
  },
  down: (db) => {
    // Drop all tables (only core tables now)
    db.exec('DROP TABLE IF EXISTS messages');
    db.exec('DROP TABLE IF EXISTS conversations');
    db.exec('DROP TABLE IF EXISTS users');
    console.log('[Migration v1] Rolled back: All tables dropped');
  },
};

/**
 * Migration v1 -> v2: Add indexes for better performance
 * Example of a schema change migration
 */
const migration_v2: IMigration = {
  version: 2,
  name: 'Add performance indexes',
  up: (db) => {
    // Add composite index for conversation messages lookup
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conv_created_desc ON messages(conversation_id, created_at DESC)');
    // Add index for message search by type
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_type_created ON messages(type, created_at DESC)');
    // Add index for user conversations lookup
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_type ON conversations(user_id, type)');
    console.log('[Migration v2] Added performance indexes');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_messages_conv_created_desc');
    db.exec('DROP INDEX IF EXISTS idx_messages_type_created');
    db.exec('DROP INDEX IF EXISTS idx_conversations_user_type');
    console.log('[Migration v2] Rolled back: Removed performance indexes');
  },
};

/**
 * Migration v2 -> v3: Add full-text search support [REMOVED]
 *
 * Note: FTS functionality has been removed as it's not currently needed.
 * Will be re-implemented when search functionality is added to the UI.
 */
const migration_v3: IMigration = {
  version: 3,
  name: 'Add full-text search (skipped)',
  up: (_db) => {
    // FTS removed - will be re-added when search functionality is implemented
    console.log('[Migration v3] FTS support skipped (removed, will be added back later)');
  },
  down: (db) => {
    // Clean up FTS table if it exists from older versions
    db.exec('DROP TABLE IF EXISTS messages_fts');
    console.log('[Migration v3] Rolled back: Removed full-text search');
  },
};

/**
 * Migration v3 -> v4: Removed (user_preferences table no longer needed)
 */
const migration_v4: IMigration = {
  version: 4,
  name: 'Removed user_preferences table',
  up: (_db) => {
    // user_preferences table removed from schema
    console.log('[Migration v4] Skipped (user_preferences table removed)');
  },
  down: (_db) => {
    console.log('[Migration v4] Rolled back: No-op (user_preferences table removed)');
  },
};

/**
 * Migration v4 -> v5: Remove FTS table
 * Cleanup for FTS removal - ensures all databases have consistent schema
 */
const migration_v5: IMigration = {
  version: 5,
  name: 'Remove FTS table',
  up: (db) => {
    // Remove FTS table created by old v3 migration
    db.exec('DROP TABLE IF EXISTS messages_fts');
    console.log('[Migration v5] Removed FTS table (cleanup for FTS removal)');
  },
  down: (_db) => {
    // If rolling back, we don't recreate FTS table (it's deprecated)
    console.log('[Migration v5] Rolled back: FTS table remains removed (deprecated feature)');
  },
};

/**
 * Migration v5 -> v6: Add jwt_secret column to users table
 * Store JWT secret per user for better security and management
 */
const migration_v6: IMigration = {
  version: 6,
  name: 'Add jwt_secret to users table',
  up: (db) => {
    // Check if jwt_secret column already exists
    const tableInfo = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    const hasJwtSecret = tableInfo.some((col) => col.name === 'jwt_secret');

    if (!hasJwtSecret) {
      // Add jwt_secret column to users table
      db.exec('ALTER TABLE users ADD COLUMN jwt_secret TEXT');
      console.log('[Migration v6] Added jwt_secret column to users table');
    } else {
      console.log('[Migration v6] jwt_secret column already exists, skipping');
    }
  },
  down: (db) => {
    // SQLite doesn't support DROP COLUMN directly, need to recreate table
    db.exec(
      'CREATE TABLE users_backup AS SELECT id, username, email, password_hash, avatar_path, created_at, updated_at, last_login FROM users'
    );
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_backup RENAME TO users');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    console.log('[Migration v6] Rolled back: Removed jwt_secret column from users table');
  },
};

/**
 * Migration v6 -> v7: Add Personal Assistant tables
 * Supports remote interaction through messaging platforms (Telegram, Slack, Discord)
 */
const migration_v7: IMigration = {
  version: 7,
  name: 'Add Personal Assistant tables',
  up: (db) => {
    // Assistant plugins configuration
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_plugins (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram', 'slack', 'discord')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        status TEXT CHECK(status IN ('created', 'initializing', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error')),
        last_connected INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_type ON assistant_plugins(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_enabled ON assistant_plugins(enabled)');

    // Authorized users whitelist
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_users (
        id TEXT PRIMARY KEY,
        platform_user_id TEXT NOT NULL,
        platform_type TEXT NOT NULL,
        display_name TEXT,
        authorized_at INTEGER NOT NULL,
        last_active INTEGER,
        session_id TEXT,
        UNIQUE(platform_user_id, platform_type)
      )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_assistant_users_platform ON assistant_users(platform_type, platform_user_id)'
    );

    // User sessions
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_type TEXT NOT NULL CHECK(agent_type IN ('gemini', 'acp', 'codex')),
        conversation_id TEXT,
        workspace TEXT,
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES assistant_users(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_sessions_user ON assistant_sessions(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_sessions_conversation ON assistant_sessions(conversation_id)');

    // Pending pairing requests
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_pairing_codes (
        code TEXT PRIMARY KEY,
        platform_user_id TEXT NOT NULL,
        platform_type TEXT NOT NULL,
        display_name TEXT,
        requested_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'expired'))
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_pairing_expires ON assistant_pairing_codes(expires_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_pairing_status ON assistant_pairing_codes(status)');

    console.log('[Migration v7] Added Personal Assistant tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS assistant_pairing_codes');
    db.exec('DROP TABLE IF EXISTS assistant_sessions');
    db.exec('DROP TABLE IF EXISTS assistant_users');
    db.exec('DROP TABLE IF EXISTS assistant_plugins');
    console.log('[Migration v7] Rolled back: Removed Personal Assistant tables');
  },
};

/**
 * Migration v7 -> v8: Add source column to conversations table
 */
const migration_v8: IMigration = {
  version: 8,
  name: 'Add source column to conversations',
  up: (db) => {
    // Add source column to conversations table
    db.exec(`ALTER TABLE conversations ADD COLUMN source TEXT CHECK(source IN ('aionui', 'telegram'))`);

    // Create index for efficient source-based queries
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v8] Added source column to conversations table');
  },
  down: (db) => {
    // SQLite doesn't support DROP COLUMN directly, need to recreate table
    // For simplicity, just drop the indexes (column will remain)
    db.exec('DROP INDEX IF EXISTS idx_conversations_source');
    db.exec('DROP INDEX IF EXISTS idx_conversations_source_updated');
    console.log('[Migration v8] Rolled back: Removed source indexes');
  },
};

/**
 * Migration v8 -> v9: Add cron_jobs table for scheduled tasks
 */
const migration_v9: IMigration = {
  version: 9,
  name: 'Add cron_jobs table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (
        -- Basic info
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,

        -- Schedule
        schedule_kind TEXT NOT NULL,       -- 'at' | 'every' | 'cron'
        schedule_value TEXT NOT NULL,      -- timestamp | ms | cron expr
        schedule_tz TEXT,                  -- timezone (optional)
        schedule_description TEXT NOT NULL, -- human-readable description

        -- Target
        payload_message TEXT NOT NULL,

        -- Metadata (for management)
        conversation_id TEXT NOT NULL,     -- Which conversation created this
        conversation_title TEXT,           -- For display in UI
        agent_type TEXT NOT NULL,          -- 'gemini' | 'claude' | 'codex' | etc.
        created_by TEXT NOT NULL,          -- 'user' | 'agent'
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),

        -- Runtime state
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_status TEXT,                  -- 'ok' | 'error' | 'skipped'
        last_error TEXT,                   -- Error message if failed
        run_count INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3
      )`);
    // Index for querying jobs by conversation (frontend management)
    db.exec('CREATE INDEX IF NOT EXISTS idx_cron_jobs_conversation ON cron_jobs(conversation_id)');
    // Index for scheduler to find next jobs to run
    db.exec('CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs(next_run_at) WHERE enabled = 1');
    // Index for querying by agent type (if needed)
    db.exec('CREATE INDEX IF NOT EXISTS idx_cron_jobs_agent_type ON cron_jobs(agent_type)');
    console.log('[Migration v9] Added cron_jobs table');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_cron_jobs_agent_type');
    db.exec('DROP INDEX IF EXISTS idx_cron_jobs_next_run');
    db.exec('DROP INDEX IF EXISTS idx_cron_jobs_conversation');
    db.exec('DROP TABLE IF EXISTS cron_jobs');
    console.log('[Migration v9] Rolled back: Removed cron_jobs table');
  },
};

/**
 * Migration v9 -> v10: Add 'lark' to assistant_plugins type constraint
 */
const migration_v10: IMigration = {
  version: 10,
  name: 'Add lark to assistant_plugins type constraint',
  up: (db) => {
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints
    // We need to recreate the table with the new constraint
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_plugins_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram', 'slack', 'discord', 'lark')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        status TEXT CHECK(status IN ('created', 'initializing', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error')),
        last_connected INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec('INSERT OR IGNORE INTO assistant_plugins_new SELECT * FROM assistant_plugins');
    db.exec('DROP TABLE IF EXISTS assistant_plugins');
    db.exec('ALTER TABLE assistant_plugins_new RENAME TO assistant_plugins');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_type ON assistant_plugins(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_enabled ON assistant_plugins(enabled)');

    console.log('[Migration v10] Added lark to assistant_plugins type constraint');
  },
  down: (db) => {
    // Rollback: recreate table without lark type (data with lark type will be lost)
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_plugins_old (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram', 'slack', 'discord')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        status TEXT CHECK(status IN ('created', 'initializing', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error')),
        last_connected INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec(`INSERT OR IGNORE INTO assistant_plugins_old SELECT * FROM assistant_plugins WHERE type != 'lark'`);
    db.exec('DROP TABLE IF EXISTS assistant_plugins');
    db.exec('ALTER TABLE assistant_plugins_old RENAME TO assistant_plugins');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_type ON assistant_plugins(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_enabled ON assistant_plugins(enabled)');
    console.log('[Migration v10] Rolled back: Removed lark from assistant_plugins type constraint');
  },
};

/**
 * Migration v10 -> v11: Add 'openclaw-gateway' to conversations type constraint
 */
const migration_v11: IMigration = {
  version: 11,
  name: 'Add openclaw-gateway to conversations type constraint',
  up: (db) => {
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints.
    // We recreate the table with the new constraint.
    // NOTE: The migration runner disables foreign_keys before the transaction,
    // so DROP TABLE will NOT trigger ON DELETE CASCADE on the messages table.

    // Clean up any invalid source values before copying
    db.exec(`UPDATE conversations SET source = NULL WHERE source IS NOT NULL AND source NOT IN ('aionui', 'telegram')`);

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v11] Added openclaw-gateway to conversations type constraint');
  },
  down: (db) => {
    // Rollback: recreate table without openclaw-gateway type
    // (data with openclaw-gateway type will be lost)
    // NOTE: foreign_keys is disabled by the migration runner before the transaction.
    db.exec(`CREATE TABLE IF NOT EXISTS conversations_rollback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_rollback (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations WHERE type != 'openclaw-gateway'`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_rollback RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v11] Rolled back: Removed openclaw-gateway from conversations type constraint');
  },
};

/**
 * Migration v11 -> v12: Add 'lark' to conversations source CHECK constraint
 */
const migration_v12: IMigration = {
  version: 12,
  name: 'Add lark to conversations source constraint',
  up: (db) => {
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints.
    // We recreate the table with the updated constraint that includes 'lark'.
    // NOTE: The migration runner disables foreign_keys before the transaction,
    // so DROP TABLE will NOT trigger ON DELETE CASCADE on the messages table.

    // Clean up any invalid source values before copying
    db.exec(
      `UPDATE conversations SET source = NULL WHERE source IS NOT NULL AND source NOT IN ('aionui', 'telegram', 'lark')`
    );

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram', 'lark')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v12] Added lark to conversations source constraint');
  },
  down: (db) => {
    // Rollback: recreate table without 'lark' in source constraint
    // NOTE: foreign_keys is disabled by the migration runner before the transaction.

    // Clean up lark source values before copying to table with stricter constraint
    db.exec(`UPDATE conversations SET source = NULL WHERE source = 'lark'`);

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_rollback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_rollback (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_rollback RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v12] Rolled back: Removed lark from conversations source constraint');
  },
};

/**
 * Migration v12 -> v13: Add 'nanobot' to conversations type CHECK constraint
 */
const migration_v13: IMigration = {
  version: 13,
  name: 'Add nanobot to conversations type constraint',
  up: (db) => {
    // SQLite doesn't support ALTER TABLE to modify CHECK constraints.
    // We recreate the table with the updated constraint that includes 'nanobot'.
    // NOTE: The migration runner disables foreign_keys before the transaction,
    // so DROP TABLE will NOT trigger ON DELETE CASCADE on the messages table.

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram', 'lark')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v13] Added nanobot to conversations type constraint');
  },
  down: (db) => {
    // Rollback: recreate table without 'nanobot' in type constraint
    // NOTE: foreign_keys is disabled by the migration runner before the transaction.

    // Remove nanobot conversations before copying to table with stricter constraint
    db.exec(`DELETE FROM conversations WHERE type = 'nanobot'`);

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_rollback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram', 'lark')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_rollback (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_rollback RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v13] Rolled back: Removed nanobot from conversations type constraint');
  },
};

/**
 * Migration v13 -> v14: Add 'dingtalk' to assistant_plugins type and conversations source CHECK constraints
 */
const migration_v14: IMigration = {
  version: 14,
  name: 'Add dingtalk to assistant_plugins type and conversations source constraints',
  up: (db) => {
    // 1. Recreate assistant_plugins with 'dingtalk' in type constraint
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_plugins_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram', 'slack', 'discord', 'lark', 'dingtalk')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        status TEXT CHECK(status IN ('created', 'initializing', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error')),
        last_connected INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec('INSERT OR IGNORE INTO assistant_plugins_new SELECT * FROM assistant_plugins');
    db.exec('DROP TABLE IF EXISTS assistant_plugins');
    db.exec('ALTER TABLE assistant_plugins_new RENAME TO assistant_plugins');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_type ON assistant_plugins(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_enabled ON assistant_plugins(enabled)');

    // 2. Recreate conversations with 'dingtalk' in source constraint
    // NOTE: The migration runner disables foreign_keys before the transaction,
    // so DROP TABLE will NOT trigger ON DELETE CASCADE on the messages table.
    db.exec(
      `UPDATE conversations SET source = NULL WHERE source IS NOT NULL AND source NOT IN ('aionui', 'telegram', 'lark', 'dingtalk')`
    );

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram', 'lark', 'dingtalk')),
        channel_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, NULL, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_source_chat ON conversations(source, channel_chat_id, updated_at DESC)'
    );

    // 3. Add chat_id to assistant_sessions for per-chat session isolation
    const sessTableInfo = db.prepare('PRAGMA table_info(assistant_sessions)').all() as Array<{ name: string }>;
    if (!sessTableInfo.some((col) => col.name === 'chat_id')) {
      db.exec('ALTER TABLE assistant_sessions ADD COLUMN chat_id TEXT');
    }

    console.log('[Migration v14] Added dingtalk support and channel_chat_id for per-chat isolation');
  },
  down: (db) => {
    // Rollback assistant_plugins: remove 'dingtalk'
    db.exec(`DELETE FROM assistant_plugins WHERE type = 'dingtalk'`);

    db.exec(`CREATE TABLE IF NOT EXISTS assistant_plugins_old (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('telegram', 'slack', 'discord', 'lark')),
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        status TEXT CHECK(status IN ('created', 'initializing', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error')),
        last_connected INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec(`INSERT OR IGNORE INTO assistant_plugins_old SELECT * FROM assistant_plugins WHERE type != 'dingtalk'`);
    db.exec('DROP TABLE IF EXISTS assistant_plugins');
    db.exec('ALTER TABLE assistant_plugins_old RENAME TO assistant_plugins');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_type ON assistant_plugins(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_enabled ON assistant_plugins(enabled)');

    // Rollback conversations: remove 'dingtalk' from source
    db.exec(`UPDATE conversations SET source = NULL WHERE source = 'dingtalk'`);

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_rollback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT CHECK(source IS NULL OR source IN ('aionui', 'telegram', 'lark')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_rollback (id, user_id, name, type, extra, model, status, source, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_rollback RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');

    console.log('[Migration v14] Rolled back: Removed dingtalk and channel_chat_id');
  },
};

/**
 * All migrations in order
 */
/**
 * Migration v14 -> v15: Remove strict CHECK constraints on type/source
 * to allow extension-contributed channel plugins.
 */
const migration_v15: IMigration = {
  version: 15,
  name: 'Remove strict constraints for extension channels',
  up: (db) => {
    // 1. Recreate assistant_plugins without strict type constraint
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_plugins_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL, -- Removed CHECK constraint
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        status TEXT CHECK(status IN ('created', 'initializing', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error')),
        last_connected INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec('INSERT OR IGNORE INTO assistant_plugins_new SELECT * FROM assistant_plugins');
    db.exec('DROP TABLE IF EXISTS assistant_plugins');
    db.exec('ALTER TABLE assistant_plugins_new RENAME TO assistant_plugins');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_type ON assistant_plugins(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_plugins_enabled ON assistant_plugins(enabled)');

    // 2. Recreate conversations without strict source constraint
    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT, -- Removed CHECK constraint
        channel_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_source_chat ON conversations(source, channel_chat_id, updated_at DESC)'
    );

    console.log('[Migration v15] Removed strict constraints for extension channels');
  },
  down: (_db) => {
    // Cannot safely rollback if there are custom types/sources in the database.
    // For now, we just log a warning and do nothing, or we could delete them.
    console.warn('[Migration v15] Rollback skipped to prevent data loss of extension channels.');
  },
};

/**
 * Migration v15 -> v16: Add remote_agents table + 'remote' to conversations type
 */
const migration_v16: IMigration = {
  version: 16,
  name: 'Add remote_agents table and remote conversation type',
  up: (db) => {
    // 1. Create remote_agents table
    db.exec(`CREATE TABLE IF NOT EXISTS remote_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'openclaw',
        url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'bearer',
        auth_token TEXT,
        avatar TEXT,
        description TEXT,
        status TEXT DEFAULT 'unknown',
        last_connected_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_remote_agents_protocol ON remote_agents(protocol)');

    // 2. Recreate conversations with 'remote' added to type CHECK
    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot', 'remote')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT,
        channel_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_source_chat ON conversations(source, channel_chat_id, updated_at DESC)'
    );

    console.log('[Migration v16] Added remote_agents table and remote conversation type');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_remote_agents_protocol');
    db.exec('DROP TABLE IF EXISTS remote_agents');
    console.log('[Migration v16] Rolled back: Removed remote_agents table');
  },
};

/**
 * Migration v16 -> v17: Add device identity columns to remote_agents
 */
const migration_v17: IMigration = {
  version: 17,
  name: 'Add device identity columns to remote_agents',
  up: (db) => {
    const columns = new Set((db.pragma('table_info(remote_agents)') as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has('device_id')) {
      db.exec('ALTER TABLE remote_agents ADD COLUMN device_id TEXT');
    }
    if (!columns.has('device_public_key')) {
      db.exec('ALTER TABLE remote_agents ADD COLUMN device_public_key TEXT');
    }
    if (!columns.has('device_private_key')) {
      db.exec('ALTER TABLE remote_agents ADD COLUMN device_private_key TEXT');
    }
    if (!columns.has('device_token')) {
      db.exec('ALTER TABLE remote_agents ADD COLUMN device_token TEXT');
    }
    console.log('[Migration v17] Added device identity columns to remote_agents');
  },
  down: (_db) => {
    // SQLite does not support DROP COLUMN before 3.35.0; skip rollback to prevent data loss.
    console.warn('[Migration v17] Rollback skipped: cannot drop columns safely.');
  },
};

/**
 * Migration v17 -> v18: Add allow_insecure column to remote_agents
 */
const migration_v18: IMigration = {
  version: 18,
  name: 'Add allow_insecure column to remote_agents',
  up: (db) => {
    const columns = new Set((db.pragma('table_info(remote_agents)') as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has('allow_insecure')) {
      db.exec('ALTER TABLE remote_agents ADD COLUMN allow_insecure INTEGER DEFAULT 0');
    }
    console.log('[Migration v18] Added allow_insecure column to remote_agents');
  },
  down: (_db) => {
    // SQLite does not support DROP COLUMN before 3.35.0; skip rollback to prevent data loss.
    console.warn('[Migration v18] Rollback skipped: cannot drop columns safely.');
  },
};

/**
 * Migration v18 -> v19: Add teams table for Team mode
 *
 * NOTE: This migration intentionally omits `lead_agent_id`. That column was
 * added in v20 via ALTER TABLE. Users who upgrade directly to v20+ get the
 * column via the v20 migration; the omission here is a known historical gap,
 * not a bug. Do NOT add `lead_agent_id` here — it would conflict with v20.
 */
const migration_v19: IMigration = {
  version: 19,
  name: 'Add teams table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL,
      workspace_mode TEXT NOT NULL DEFAULT 'shared',
      agents TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_teams_user_id ON teams(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_teams_updated_at ON teams(updated_at)');
  },
  down: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_teams_updated_at');
    db.exec('DROP INDEX IF EXISTS idx_teams_user_id');
    db.exec('DROP TABLE IF EXISTS teams');
  },
};

const migration_v20: IMigration = {
  version: 20,
  name: 'Add lead_agent_id to teams, create mailbox and team_tasks tables',
  up: (db) => {
    // Ensure teams table exists (v19 should have created it, but guard against
    // dev databases where v19 ran without the teams migration content)
    db.exec(`CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace TEXT NOT NULL,
      workspace_mode TEXT NOT NULL DEFAULT 'shared',
      agents TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_teams_user_id ON teams(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_teams_updated_at ON teams(updated_at)');

    // Add lead_agent_id column (ignore if already exists from a prior v19 run)
    try {
      db.exec(`ALTER TABLE teams ADD COLUMN lead_agent_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — safe to ignore
    }
    db.exec(`CREATE TABLE IF NOT EXISTS mailbox (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'message',
      content TEXT NOT NULL,
      summary TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(team_id, to_agent_id, read)');
    db.exec(`CREATE TABLE IF NOT EXISTS team_tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      owner TEXT,
      blocked_by TEXT NOT NULL DEFAULT '[]',
      blocks TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_team ON team_tasks(team_id, status)');
  },
  down: (db) => {
    // SQLite does not support DROP COLUMN; leave lead_agent_id in place
    db.exec('DROP INDEX IF EXISTS idx_tasks_team');
    db.exec('DROP TABLE IF EXISTS team_tasks');
    db.exec('DROP INDEX IF EXISTS idx_mailbox_to');
    db.exec('DROP TABLE IF EXISTS mailbox');
  },
};

/**
 * Migration v20 -> v21: Add 'aionrs' to conversations type CHECK constraint
 */
const migration_v21: IMigration = {
  version: 21,
  name: "Add 'aionrs' to conversations type CHECK",
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot', 'remote', 'aionrs')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT,
        channel_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_source_chat ON conversations(source, channel_chat_id, updated_at DESC)'
    );
    console.log("[Migration v21] Added 'aionrs' to conversations type CHECK");
  },
  down: (db) => {
    // Remove aionrs conversations before copying to table with stricter constraint
    db.exec(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'aionrs')`);
    db.exec(`DELETE FROM conversations WHERE type = 'aionrs'`);

    db.exec(`CREATE TABLE IF NOT EXISTS conversations_rollback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('gemini', 'acp', 'codex', 'openclaw-gateway', 'nanobot', 'remote')),
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT,
        channel_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_rollback (id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_rollback RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_source_chat ON conversations(source, channel_chat_id, updated_at DESC)'
    );

    console.log("[Migration v21] Rolled back: Removed 'aionrs' from conversations type CHECK");
  },
};

/**
 * Migration v21 -> v22: Remove CHECK constraint on conversations.type,
 * add cron job columns, hidden messages, and cronJobId index.
 *
 * The CHECK(type IN (...)) constraint forced a heavy table-rebuild migration
 * every time a new agent type was added (v10, v11, v14, v15, v16, v21 all did this).
 * By removing the constraint, new agent types only need TypeScript-level changes
 * (TChatConversation union + rowToConversation branch) — no database migration.
 */
const migration_v22: IMigration = {
  version: 22,
  name: 'Remove type CHECK, add cron columns, hidden messages',
  up: (db) => {
    // 1. Remove CHECK constraint on conversations.type
    db.exec(`CREATE TABLE IF NOT EXISTS conversations_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        extra TEXT NOT NULL,
        model TEXT,
        status TEXT CHECK(status IN ('pending', 'running', 'finished')),
        source TEXT,
        channel_chat_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);
    db.exec(`INSERT INTO conversations_new (id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at)
      SELECT id, user_id, name, type, extra, model, status, source, channel_chat_id, created_at, updated_at FROM conversations`);
    db.exec('DROP TABLE conversations');
    db.exec('ALTER TABLE conversations_new RENAME TO conversations');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source_updated ON conversations(source, updated_at DESC)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_source_chat ON conversations(source, channel_chat_id, updated_at DESC)'
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conversations_cron_job_id ON conversations(json_extract(extra, '$.cronJobId'))`
    );

    // 2. Add cron job columns (execution_mode, agent_config)
    const cronColumns = new Set((db.pragma('table_info(cron_jobs)') as Array<{ name: string }>).map((c) => c.name));
    if (!cronColumns.has('execution_mode')) {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN execution_mode TEXT DEFAULT 'existing'`);
    }
    if (!cronColumns.has('agent_config')) {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN agent_config TEXT`);
    }
    // Fix legacy jobs: empty conversation_id means they were created before execution_mode existed
    db.exec(
      `UPDATE cron_jobs SET execution_mode = 'new_conversation' WHERE conversation_id = '' OR conversation_id IS NULL`
    );

    // 3. Add hidden column to messages
    const msgColumns = new Set((db.pragma('table_info(messages)') as Array<{ name: string }>).map((c) => c.name));
    if (!msgColumns.has('hidden')) {
      db.exec(`ALTER TABLE messages ADD COLUMN hidden INTEGER DEFAULT 0`);
    }

    console.log('[Migration v22] Removed type CHECK, added cron columns, hidden messages');
  },
  down: (_db) => {
    // Cannot safely rollback — re-adding CHECK would reject unknown types already in the table.
    console.warn('[Migration v22] Rollback skipped: re-adding CHECK constraint could reject existing data.');
  },
};

/**
 * Migration v22 -> v23: Add activity_log and secrets tables (TitanX observability + security)
 */
const migration_v23: IMigration = {
  version: 23,
  name: 'Add activity_log and secrets tables',
  up: (db) => {
    // Immutable audit trail
    db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'user',
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      agent_id TEXT,
      details TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_activity_log_agent ON activity_log(agent_id)');

    // Encrypted secrets vault
    db.exec(`CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'local_encrypted',
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_secrets_user ON secrets(user_id)');

    // Secret version history (encrypted values)
    db.exec(`CREATE TABLE IF NOT EXISTS secret_versions (
      id TEXT PRIMARY KEY,
      secret_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      material TEXT NOT NULL,
      value_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE CASCADE,
      UNIQUE(secret_id, version)
    )`);

    console.log('[Migration v23] Added activity_log and secrets tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS secret_versions');
    db.exec('DROP TABLE IF EXISTS secrets');
    db.exec('DROP INDEX IF EXISTS idx_activity_log_agent');
    db.exec('DROP INDEX IF EXISTS idx_activity_log_action');
    db.exec('DROP INDEX IF EXISTS idx_activity_log_entity');
    db.exec('DROP INDEX IF EXISTS idx_activity_log_user');
    db.exec('DROP TABLE IF EXISTS activity_log');
    console.log('[Migration v23] Rolled back: Removed activity_log and secrets tables');
  },
};

/**
 * Migration v23 -> v24: Add cost tracking and budget tables (TitanX observability)
 */
const migration_v24: IMigration = {
  version: 24,
  name: 'Add cost_events, budget_policies, and budget_incidents tables',
  up: (db) => {
    // Cost event ledger
    db.exec(`CREATE TABLE IF NOT EXISTS cost_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      agent_type TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      billing_type TEXT DEFAULT 'metered_api',
      occurred_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cost_events_user ON cost_events(user_id, occurred_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cost_events_agent ON cost_events(agent_type, occurred_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cost_events_provider ON cost_events(provider, model)');

    // Budget policies
    db.exec(`CREATE TABLE IF NOT EXISTS budget_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      amount_cents INTEGER NOT NULL,
      window_kind TEXT NOT NULL DEFAULT 'monthly',
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_budget_policies_user ON budget_policies(user_id, scope_type)');

    // Budget incidents (overage alerts)
    db.exec(`CREATE TABLE IF NOT EXISTS budget_incidents (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      spend_cents INTEGER NOT NULL,
      limit_cents INTEGER NOT NULL,
      paused_resources TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (policy_id) REFERENCES budget_policies(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_budget_incidents_user ON budget_incidents(user_id, status)');

    console.log('[Migration v24] Added cost_events, budget_policies, and budget_incidents tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS budget_incidents');
    db.exec('DROP TABLE IF EXISTS budget_policies');
    db.exec('DROP TABLE IF EXISTS cost_events');
    console.log('[Migration v24] Rolled back: Removed cost tracking and budget tables');
  },
};

/**
 * Migration v24 -> v25: Add agent_runs and approvals tables (TitanX observability + security)
 */
const migration_v25: IMigration = {
  version: 25,
  name: 'Add agent_runs and approvals tables',
  up: (db) => {
    // Agent run tracking
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_cents INTEGER DEFAULT 0,
      exit_code INTEGER,
      error TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id, started_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_type, started_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)');

    // Approval workflows
    db.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      decision_note TEXT,
      decided_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_user ON approvals(user_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC)');

    console.log('[Migration v25] Added agent_runs and approvals tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS approvals');
    db.exec('DROP TABLE IF EXISTS agent_runs');
    console.log('[Migration v25] Rolled back: Removed agent_runs and approvals tables');
  },
};

/**
 * Migration v25 -> v26: Add sprint board tables (TitanX Agent Sprint)
 */
const migration_v26: IMigration = {
  version: 26,
  name: 'Add sprint_tasks and sprint_counters tables',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS sprint_tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      assignee_slot_id TEXT,
      priority TEXT DEFAULT 'medium',
      labels TEXT DEFAULT '[]',
      blocked_by TEXT DEFAULT '[]',
      comments TEXT DEFAULT '[]',
      sprint_number INTEGER,
      story_points INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sprint_tasks_team ON sprint_tasks(team_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sprint_tasks_assignee ON sprint_tasks(assignee_slot_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS sprint_counters (
      team_id TEXT PRIMARY KEY,
      next_id INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )`);

    console.log('[Migration v26] Added sprint_tasks and sprint_counters tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS sprint_counters');
    db.exec('DROP TABLE IF EXISTS sprint_tasks');
    console.log('[Migration v26] Rolled back: Removed sprint tables');
  },
};

/**
 * Migration v26 -> v27: Add agent gallery table (TitanX Agent Gallery)
 */
const migration_v27: IMigration = {
  version: 27,
  name: 'Add agent_gallery table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_gallery (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      description TEXT,
      avatar_sprite_idx INTEGER DEFAULT 0,
      capabilities TEXT DEFAULT '[]',
      config TEXT DEFAULT '{}',
      whitelisted INTEGER DEFAULT 1,
      max_budget_cents INTEGER,
      allowed_tools TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_gallery_user ON agent_gallery(user_id, whitelisted)');

    console.log('[Migration v27] Added agent_gallery table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_gallery');
    console.log('[Migration v27] Rolled back: Removed agent_gallery table');
  },
};

/**
 * Migration v27 -> v28: Add workflow_rules table (TitanX Governance)
 */
const migration_v28: IMigration = {
  version: 28,
  name: 'Add workflow_rules table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      trigger_condition TEXT NOT NULL,
      action TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_rules_user ON workflow_rules(user_id, type)');

    console.log('[Migration v28] Added workflow_rules table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS workflow_rules');
    console.log('[Migration v28] Rolled back: Removed workflow_rules table');
  },
};

/**
 * Migration v28 -> v29: Add IAM policy tables (TitanX Governance)
 */
const migration_v29: IMigration = {
  version: 29,
  name: 'Add iam_policies and agent_policy_bindings tables',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS iam_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      permissions TEXT NOT NULL,
      ttl_seconds INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_iam_policies_user ON iam_policies(user_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS agent_policy_bindings (
      id TEXT PRIMARY KEY,
      agent_gallery_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (agent_gallery_id) REFERENCES agent_gallery(id) ON DELETE CASCADE,
      FOREIGN KEY (policy_id) REFERENCES iam_policies(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_policy_bindings ON agent_policy_bindings(agent_gallery_id)');

    console.log('[Migration v29] Added iam_policies and agent_policy_bindings tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_policy_bindings');
    db.exec('DROP TABLE IF EXISTS iam_policies');
    console.log('[Migration v29] Rolled back: Removed IAM tables');
  },
};

/**
 * All migrations in order
 */
/**
 * Migration v29 -> v30: Add project_plans table and enhance sprint_tasks
 */
const migration_v30: IMigration = {
  version: 30,
  name: 'Add project_plans table and sprint task enhancements',
  up: (db) => {
    // Project plans with calendar scheduling
    db.exec(`CREATE TABLE IF NOT EXISTS project_plans (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      scheduled_date INTEGER NOT NULL,
      scheduled_time TEXT,
      duration_minutes INTEGER DEFAULT 60,
      recurrence TEXT,
      color TEXT DEFAULT '#165dff',
      sprint_task_ids TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_plans_team ON project_plans(team_id, scheduled_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_project_plans_status ON project_plans(status, scheduled_date)');

    // Enhance sprint_tasks with new columns
    const cols = new Set((db.pragma('table_info(sprint_tasks)') as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('linked_tasks')) db.exec("ALTER TABLE sprint_tasks ADD COLUMN linked_tasks TEXT DEFAULT '[]'");
    if (!cols.has('scheduled_at')) db.exec('ALTER TABLE sprint_tasks ADD COLUMN scheduled_at INTEGER');
    if (!cols.has('plan_id')) db.exec('ALTER TABLE sprint_tasks ADD COLUMN plan_id TEXT');
    if (!cols.has('due_date')) db.exec('ALTER TABLE sprint_tasks ADD COLUMN due_date INTEGER');

    console.log('[Migration v30] Added project_plans table and sprint task enhancements');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS project_plans');
    console.log('[Migration v30] Rolled back: Removed project_plans table');
  },
};

/**
 * Migration v30 -> v31: Agent templates, IAM agent/credential binding, credential access tokens
 */
const migration_v31: IMigration = {
  version: 31,
  name: 'Agent templates, IAM credential binding, access tokens',
  up: (db) => {
    // Agent gallery template fields
    const galleryCols = new Set((db.pragma('table_info(agent_gallery)') as Array<{ name: string }>).map((c) => c.name));
    if (!galleryCols.has('published')) db.exec('ALTER TABLE agent_gallery ADD COLUMN published INTEGER DEFAULT 0');
    if (!galleryCols.has('instructions_md')) db.exec('ALTER TABLE agent_gallery ADD COLUMN instructions_md TEXT');
    if (!galleryCols.has('skills_md')) db.exec('ALTER TABLE agent_gallery ADD COLUMN skills_md TEXT');
    if (!galleryCols.has('heartbeat_md')) db.exec('ALTER TABLE agent_gallery ADD COLUMN heartbeat_md TEXT');
    if (!galleryCols.has('heartbeat_interval_sec'))
      db.exec('ALTER TABLE agent_gallery ADD COLUMN heartbeat_interval_sec INTEGER DEFAULT 0');
    if (!galleryCols.has('heartbeat_enabled'))
      db.exec('ALTER TABLE agent_gallery ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0');
    if (!galleryCols.has('env_bindings'))
      db.exec("ALTER TABLE agent_gallery ADD COLUMN env_bindings TEXT DEFAULT '{}'");

    // IAM policy agent + credential lists
    const iamCols = new Set((db.pragma('table_info(iam_policies)') as Array<{ name: string }>).map((c) => c.name));
    if (!iamCols.has('agent_ids')) db.exec("ALTER TABLE iam_policies ADD COLUMN agent_ids TEXT DEFAULT '[]'");
    if (!iamCols.has('credential_ids')) db.exec("ALTER TABLE iam_policies ADD COLUMN credential_ids TEXT DEFAULT '[]'");

    // Credential access tokens — time-limited secrets issued to agents
    db.exec(`CREATE TABLE IF NOT EXISTS credential_access_tokens (
      id TEXT PRIMARY KEY,
      agent_gallery_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      secret_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked INTEGER DEFAULT 0,
      FOREIGN KEY (agent_gallery_id) REFERENCES agent_gallery(id) ON DELETE CASCADE,
      FOREIGN KEY (policy_id) REFERENCES iam_policies(id) ON DELETE CASCADE,
      FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_cat_agent ON credential_access_tokens(agent_gallery_id, revoked)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cat_expires ON credential_access_tokens(expires_at)');

    console.log('[Migration v31] Added agent templates, IAM credential binding, access tokens');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS credential_access_tokens');
    console.log('[Migration v31] Rolled back: Removed credential_access_tokens');
  },
};

/**
 * Migration v31 -> v32: Security hardening — immutable audit logs, HMAC signatures
 */
const migration_v32: IMigration = {
  version: 32,
  name: 'Security hardening: immutable audit logs',
  up: (db) => {
    // Add HMAC signature column to activity_log
    const cols = new Set((db.pragma('table_info(activity_log)') as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('signature')) {
      db.exec('ALTER TABLE activity_log ADD COLUMN signature TEXT');
    }
    if (!cols.has('severity')) {
      db.exec("ALTER TABLE activity_log ADD COLUMN severity TEXT DEFAULT 'info'");
    }

    // Make activity_log append-only: prevent UPDATE and DELETE
    db.exec(`CREATE TRIGGER IF NOT EXISTS prevent_activity_log_update
      BEFORE UPDATE ON activity_log
      BEGIN
        SELECT RAISE(ABORT, 'activity_log is immutable: updates are not allowed');
      END`);

    db.exec(`CREATE TRIGGER IF NOT EXISTS prevent_activity_log_delete
      BEFORE DELETE ON activity_log
      BEGIN
        SELECT RAISE(ABORT, 'activity_log is immutable: deletes are not allowed');
      END`);

    console.log('[Migration v32] Added audit log signatures and immutability triggers');
  },
  down: (db) => {
    db.exec('DROP TRIGGER IF EXISTS prevent_activity_log_delete');
    db.exec('DROP TRIGGER IF EXISTS prevent_activity_log_update');
    console.log('[Migration v32] Rolled back: Removed audit log triggers');
  },
};

/**
 * Migration v32 -> v33: Add team_task_id to sprint_tasks for reliable status sync
 */
const migration_v33: IMigration = {
  version: 33,
  name: 'Add team_task_id to sprint_tasks',
  up: (db) => {
    const cols = new Set((db.pragma('table_info(sprint_tasks)') as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('team_task_id')) {
      db.exec('ALTER TABLE sprint_tasks ADD COLUMN team_task_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sprint_team_task ON sprint_tasks(team_task_id)');
    }
    console.log('[Migration v33] Added team_task_id to sprint_tasks');
  },
  down: (_db) => {
    console.warn('[Migration v33] Rollback skipped: cannot drop columns safely');
  },
};

/**
 * Migration v33 -> v34: Agent session tokens for runtime IAM enforcement.
 * Per-agent scoped tokens with policy snapshots and auto-expiry.
 */
const migration_v34: IMigration = {
  version: 34,
  name: 'Add agent_session_tokens table for runtime IAM',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_session_tokens (
      id TEXT PRIMARY KEY,
      agent_slot_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      parent_slot_id TEXT,
      policy_snapshot TEXT NOT NULL DEFAULT '{}',
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_tokens_agent ON agent_session_tokens(agent_slot_id, revoked)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_tokens_team ON agent_session_tokens(team_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_session_tokens_expiry ON agent_session_tokens(expires_at, revoked)');
    console.log('[Migration v34] Added agent_session_tokens table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_session_tokens');
    console.log('[Migration v34] Rolled back: Dropped agent_session_tokens');
  },
};

/**
 * Migration v34 -> v35: Network egress policies (NemoClaw deny-by-default).
 */
const migration_v35: IMigration = {
  version: 35,
  name: 'Add network egress policies',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS network_policies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_gallery_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_net_policy_user ON network_policies(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_net_policy_agent ON network_policies(agent_gallery_id)');

    db.exec(`CREATE TABLE IF NOT EXISTS network_policy_rules (
      id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL REFERENCES network_policies(id) ON DELETE CASCADE,
      host TEXT NOT NULL,
      port INTEGER,
      path_prefix TEXT,
      methods TEXT,
      tls_required INTEGER NOT NULL DEFAULT 1,
      tool_scope TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_net_rule_policy ON network_policy_rules(policy_id)');
    console.log('[Migration v35] Added network_policies + network_policy_rules tables');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS network_policy_rules');
    db.exec('DROP TABLE IF EXISTS network_policies');
    console.log('[Migration v35] Rolled back: Dropped network policy tables');
  },
};

/**
 * Migration v35 -> v36: Agent blueprints (NemoClaw declarative profiles).
 */
const migration_v36: IMigration = {
  version: 36,
  name: 'Add agent blueprints table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_blueprints (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_blueprint_user ON agent_blueprints(user_id)');
    console.log('[Migration v36] Added agent_blueprints table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_blueprints');
    console.log('[Migration v36] Rolled back: Dropped agent_blueprints');
  },
};

/**
 * Migration v36 -> v37: Agent snapshots (NemoClaw state capture/restore).
 */
const migration_v37: IMigration = {
  version: 37,
  name: 'Add agent snapshots table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_snapshots (
      id TEXT PRIMARY KEY,
      agent_gallery_id TEXT NOT NULL,
      team_id TEXT,
      version INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      note TEXT,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_snapshot_agent ON agent_snapshots(agent_gallery_id, version DESC)');
    console.log('[Migration v37] Added agent_snapshots table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_snapshots');
    console.log('[Migration v37] Rolled back: Dropped agent_snapshots');
  },
};

/**
 * Migration v37 -> v38: Inference routing rules (NemoClaw managed inference).
 */
const migration_v38: IMigration = {
  version: 38,
  name: 'Add inference routing rules table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS inference_routing_rules (
      id TEXT PRIMARY KEY,
      agent_gallery_id TEXT,
      preferred_provider TEXT NOT NULL,
      fallback_providers TEXT NOT NULL DEFAULT '[]',
      allowed_models TEXT NOT NULL DEFAULT '[]',
      max_tokens_per_request INTEGER,
      credential_injection INTEGER NOT NULL DEFAULT 1,
      rate_limit_per_minute INTEGER,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_inf_route_agent ON inference_routing_rules(agent_gallery_id)');
    console.log('[Migration v38] Added inference_routing_rules table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS inference_routing_rules');
    console.log('[Migration v38] Rolled back: Dropped inference_routing_rules');
  },
};

/**
 * Migration v38 -> v39: Security feature toggles + blueprint enabled column.
 * Master on/off switches for each NemoClaw-inspired security feature.
 */
const migration_v39: IMigration = {
  version: 39,
  name: 'Add security feature toggles and blueprint enabled column',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS security_feature_toggles (
      feature TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    // Seed default feature toggles (all off by default — opt-in)
    const now = Date.now();
    const features = [
      'network_policies',
      'ssrf_protection',
      'filesystem_tiers',
      'blueprints',
      'agent_snapshots',
      'inference_routing',
    ];
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO security_feature_toggles (feature, enabled, updated_at) VALUES (?, 0, ?)'
    );
    for (const f of features) {
      stmt.run(f, now);
    }
    // Add enabled column to agent_blueprints
    const cols = new Set((db.pragma('table_info(agent_blueprints)') as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has('enabled')) {
      db.exec('ALTER TABLE agent_blueprints ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
    }
    console.log('[Migration v39] Added security_feature_toggles + blueprint enabled column');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS security_feature_toggles');
    console.log('[Migration v39] Rolled back: Dropped security_feature_toggles');
  },
};

// ── Phase 1: Workflow Engine (n8n-inspired) ──────────────────────────────────

const migration_v40: IMigration = {
  version: 40,
  name: 'Add workflow_definitions table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_definitions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      nodes TEXT NOT NULL DEFAULT '[]', connections TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wf_def_user ON workflow_definitions(user_id)');
    console.log('[Migration v40] Added workflow_definitions table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS workflow_definitions');
  },
};

const migration_v41: IMigration = {
  version: 41,
  name: 'Add workflow_executions table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
      trigger_data TEXT DEFAULT '{}', started_at INTEGER NOT NULL, finished_at INTEGER,
      error TEXT, created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wf_exec_workflow ON workflow_executions(workflow_id, started_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wf_exec_status ON workflow_executions(status)');
    console.log('[Migration v41] Added workflow_executions table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS workflow_executions');
  },
};

const migration_v42: IMigration = {
  version: 42,
  name: 'Add workflow_node_executions table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_node_executions (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, node_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','skipped')),
      input_data TEXT DEFAULT '{}', output_data TEXT DEFAULT '{}', error TEXT,
      retry_count INTEGER DEFAULT 0, started_at INTEGER, finished_at INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wf_node_exec ON workflow_node_executions(execution_id, node_id)');
    console.log('[Migration v42] Added workflow_node_executions table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS workflow_node_executions');
  },
};

// ── Phase 2: Agent Memory & Planning (LangChain/DeepAgents) ──────────────────

const migration_v43: IMigration = {
  version: 43,
  name: 'Add agent_memory table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY, agent_slot_id TEXT NOT NULL, team_id TEXT NOT NULL,
      memory_type TEXT NOT NULL CHECK(memory_type IN ('buffer','summary','entity','long_term')),
      content TEXT NOT NULL DEFAULT '{}', token_count INTEGER DEFAULT 0,
      relevance_score REAL DEFAULT 1.0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_agent_memory_slot ON agent_memory(agent_slot_id, memory_type, updated_at DESC)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_memory_team ON agent_memory(team_id)');
    console.log('[Migration v43] Added agent_memory table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_memory');
  },
};

const migration_v44: IMigration = {
  version: 44,
  name: 'Add agent_plans table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_plans (
      id TEXT PRIMARY KEY, agent_slot_id TEXT NOT NULL, team_id TEXT NOT NULL,
      parent_plan_id TEXT, title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','active','completed','failed','abandoned')),
      steps TEXT NOT NULL DEFAULT '[]', reflection TEXT, reflection_score REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_plan_slot ON agent_plans(agent_slot_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_plan_team ON agent_plans(team_id)');
    console.log('[Migration v44] Added agent_plans table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS agent_plans');
  },
};

// ── Phase 4: Trace System (LangSmith-compatible) ─────────────────────────────

const migration_v45: IMigration = {
  version: 45,
  name: 'Add trace_runs table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS trace_runs (
      id TEXT PRIMARY KEY, parent_run_id TEXT REFERENCES trace_runs(id), root_run_id TEXT NOT NULL,
      run_type TEXT NOT NULL CHECK(run_type IN ('chain','agent','tool','llm','retriever','workflow')),
      name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','error')),
      inputs TEXT DEFAULT '{}', outputs TEXT DEFAULT '{}', error TEXT,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0, cost_cents REAL DEFAULT 0,
      start_time INTEGER NOT NULL, end_time INTEGER,
      agent_slot_id TEXT, team_id TEXT, workflow_execution_id TEXT,
      otel_trace_id TEXT, otel_span_id TEXT,
      tags TEXT DEFAULT '[]', metadata TEXT DEFAULT '{}', created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trace_runs_parent ON trace_runs(parent_run_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trace_runs_root ON trace_runs(root_run_id, start_time DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trace_runs_agent ON trace_runs(agent_slot_id, start_time DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trace_runs_type ON trace_runs(run_type, start_time DESC)');
    console.log('[Migration v45] Added trace_runs table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS trace_runs');
  },
};

const migration_v46: IMigration = {
  version: 46,
  name: 'Add trace_feedback table',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS trace_feedback (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES trace_runs(id),
      user_id TEXT NOT NULL, score REAL, value TEXT, comment TEXT,
      category TEXT DEFAULT 'general', created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trace_feedback_run ON trace_feedback(run_id)');
    console.log('[Migration v46] Added trace_feedback table');
  },
  down: (db) => {
    db.exec('DROP TABLE IF EXISTS trace_feedback');
  },
};

// ── Phase 5: Security Feature Toggle Seeds ───────────────────────────────────

const migration_v47: IMigration = {
  version: 47,
  name: 'Seed workflow_gates and agent_memory security toggles',
  up: (db) => {
    const now = Date.now();
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO security_feature_toggles (feature, enabled, updated_at) VALUES (?, 0, ?)'
    );
    stmt.run('workflow_gates', now);
    stmt.run('agent_memory', now);
    stmt.run('agent_planning', now);
    stmt.run('trace_system', now);
    console.log('[Migration v47] Seeded workflow_gates + agent_memory + agent_planning + trace_system toggles');
  },
  down: (_db) => {
    console.warn('[Migration v47] Rollback: toggles remain');
  },
};

// ── Phase 5b: Enable trace_system + agent_planning for Deep Agent ────────────

const migration_v48: IMigration = {
  version: 48,
  name: 'Enable trace_system and agent_planning by default for Deep Agent',
  up: (db) => {
    const now = Date.now();
    db.prepare('UPDATE security_feature_toggles SET enabled = 1, updated_at = ? WHERE feature = ?').run(
      now,
      'trace_system'
    );
    db.prepare('UPDATE security_feature_toggles SET enabled = 1, updated_at = ? WHERE feature = ?').run(
      now,
      'agent_planning'
    );
    console.log('[Migration v48] Enabled trace_system + agent_planning toggles');
  },
  down: (db) => {
    const now = Date.now();
    db.prepare('UPDATE security_feature_toggles SET enabled = 0, updated_at = ? WHERE feature IN (?, ?)').run(
      now,
      'trace_system',
      'agent_planning'
    );
  },
};

// ── Phase 6: Enforce unique agent names per user ──────────────────────────────

const migration_v49: IMigration = {
  version: 49,
  name: 'Unique agent names per user in agent_gallery',
  up(db: ISqliteDriver) {
    // De-duplicate any existing rows: append _N suffix to duplicates
    const dupes = db
      .prepare(`SELECT user_id, name, COUNT(*) as cnt FROM agent_gallery GROUP BY user_id, name HAVING cnt > 1`)
      .all() as Array<{ user_id: string; name: string; cnt: number }>;

    for (const dupe of dupes) {
      const rows = db
        .prepare(`SELECT id FROM agent_gallery WHERE user_id = ? AND name = ? ORDER BY created_at ASC`)
        .all(dupe.user_id, dupe.name) as Array<{ id: string }>;
      // Keep the first, rename the rest
      for (let i = 1; i < rows.length; i++) {
        const suffix = `_${String(i)}`;
        db.prepare(`UPDATE agent_gallery SET name = ? WHERE id = ?`).run(`${dupe.name}${suffix}`, rows[i]!.id);
      }
    }

    console.log('[Migration-v49] De-duplicated agent names, creating unique index...');

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_gallery_user_name ON agent_gallery(user_id, name)`);
  },
  down(db: ISqliteDriver) {
    db.exec(`DROP INDEX IF EXISTS idx_agent_gallery_user_name`);
  },
};

// ── Phase 6b: Add category column to agent_gallery ────────────────────────────

const migration_v50: IMigration = {
  version: 50,
  name: 'Add category column to agent_gallery for segmented display',
  up(db: ISqliteDriver) {
    db.exec(`ALTER TABLE agent_gallery ADD COLUMN category TEXT DEFAULT 'technical'`);
    console.log('[Migration-v50] Added category column to agent_gallery');
  },
  down(db: ISqliteDriver) {
    // SQLite doesn't support DROP COLUMN before 3.35.0, so we just ignore
    console.log('[Migration-v50] Down: category column cannot be removed in SQLite < 3.35');
    void db;
  },
};

// ── Phase 7: Caveman Mode savings tracking ───────────────────────────────────

const migration_v51: IMigration = {
  version: 51,
  name: 'Create caveman_savings table for token savings tracking',
  up(db: ISqliteDriver) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS caveman_savings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        conversation_id TEXT,
        mode TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_regular_output INTEGER NOT NULL DEFAULT 0,
        tokens_saved INTEGER NOT NULL DEFAULT 0,
        occurred_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_caveman_savings_user ON caveman_savings(user_id, occurred_at)`);
    console.log('[Migration-v51] Created caveman_savings table');
  },
  down(db: ISqliteDriver) {
    db.exec(`DROP TABLE IF EXISTS caveman_savings`);
  },
};

// ── Phase 8: ReasoningBank for trajectory storage ─────────────────────────────

const migration_v52: IMigration = {
  version: 52,
  name: 'Create reasoning_bank table for trajectory storage and replay',
  up(db: ISqliteDriver) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reasoning_bank (
        id TEXT PRIMARY KEY,
        trajectory_hash TEXT UNIQUE,
        task_description TEXT NOT NULL,
        trajectory TEXT NOT NULL DEFAULT '[]',
        success_score REAL NOT NULL DEFAULT 0,
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reasoning_bank_hash ON reasoning_bank(trajectory_hash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_reasoning_bank_score ON reasoning_bank(success_score, usage_count)`);
    console.log('[Migration-v52] Created reasoning_bank table');
  },
  down(db: ISqliteDriver) {
    db.exec(`DROP TABLE IF EXISTS reasoning_bank`);
  },
};

// ── Phase 9: Fix seeded agent tool names to TitanX MCP-compatible names ───────

const migration_v53: IMigration = {
  version: 53,
  name: 'Fix agent gallery tool names to TitanX MCP-compatible format',
  up(db: ISqliteDriver) {
    const toolRenames: Record<string, string> = {
      edit_file: 'Edit',
      read_file: 'Read',
      write_file: 'Write',
      execute: 'Bash',
      web_search: 'WebSearch',
      grep: 'Grep',
      glob: 'Glob',
    };

    const agents = db.prepare('SELECT id, allowed_tools FROM agent_gallery').all() as Array<{
      id: string;
      allowed_tools: string;
    }>;
    let updated = 0;

    for (const agent of agents) {
      try {
        const tools = JSON.parse(agent.allowed_tools || '[]') as string[];
        let changed = false;
        const fixed = tools.map((t) => {
          if (toolRenames[t]) {
            changed = true;
            return toolRenames[t]!;
          }
          return t;
        });
        if (changed) {
          db.prepare('UPDATE agent_gallery SET allowed_tools = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(fixed),
            Date.now(),
            agent.id
          );
          updated++;
        }
      } catch {
        // Skip malformed entries
      }
    }

    console.log(`[Migration-v53] Fixed tool names for ${String(updated)} agents (${String(agents.length)} total)`);
  },
  down(_db: ISqliteDriver) {
    // Reverse rename not needed — old names were wrong
    void _db;
  },
};

// ── Phase 10: Workspace isolation tables ────────────────────────────────────

const migration_v54: IMigration = {
  version: 54,
  name: 'Create workspace isolation tables and add device identity columns to activity_log',
  up(db: ISqliteDriver) {
    // Workspaces table — multi-tenant isolation boundary
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        isolation_mode TEXT NOT NULL DEFAULT 'strict',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id)');

    // Workspace members table
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_unique ON workspace_members(workspace_id, user_id)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id)');

    // Add device identity columns to activity_log for non-repudiable audit trails
    db.exec('ALTER TABLE activity_log ADD COLUMN device_signature TEXT');
    db.exec('ALTER TABLE activity_log ADD COLUMN device_id TEXT');

    // Add workspace_id to teams table for workspace scoping
    db.exec('ALTER TABLE teams ADD COLUMN workspace_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_teams_workspace ON teams(workspace_id)');

    console.log('[Migration-v54] Created workspace tables and added device identity columns');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP TABLE IF EXISTS workspace_members');
    db.exec('DROP TABLE IF EXISTS workspaces');
    // SQLite doesn't support DROP COLUMN — columns will remain but be unused
    console.warn('[Migration-v54] Rollback: dropped workspace tables. device_* columns remain (SQLite limitation).');
  },
};

// ── Phase 11: Task lifecycle state_history column ───────────────────────────

const migration_v55: IMigration = {
  version: 55,
  name: 'Add state_history column to team_tasks for lifecycle audit trail',
  up(db: ISqliteDriver) {
    // JSON array of StateTransition records for full audit trail
    db.exec(`ALTER TABLE team_tasks ADD COLUMN state_history TEXT NOT NULL DEFAULT '[]'`);
    // Add lifecycle_state for the formal state machine (separate from sprint board 'status')
    db.exec(`ALTER TABLE team_tasks ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'queued'`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle ON team_tasks(team_id, lifecycle_state)');

    console.log('[Migration-v55] Added state_history and lifecycle_state to team_tasks');
  },
  down(_db: ISqliteDriver) {
    // SQLite doesn't support DROP COLUMN
    console.warn('[Migration-v55] Rollback: columns remain (SQLite limitation).');
    void _db;
  },
};

// ── Phase 12: Agent progress notes + owner identity normalization ────────────

const migration_v56: IMigration = {
  version: 56,
  name: 'Add progress_notes to team_tasks and normalize owner to agentName',
  up(db: ISqliteDriver) {
    // Add progress_notes column for agent resume context
    db.exec(`ALTER TABLE team_tasks ADD COLUMN progress_notes TEXT NOT NULL DEFAULT ''`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON team_tasks(team_id, owner)');

    // Normalize historical owner values from slotId to agentName.
    // Build slotId→agentName map from all teams' agents JSON.
    const teams = db.prepare('SELECT id, agents FROM teams').all() as Array<{ id: string; agents: string }>;
    const slotToName = new Map<string, string>();

    for (const team of teams) {
      try {
        const agents = JSON.parse(team.agents) as Array<{ slotId: string; agentName: string }>;
        for (const agent of agents) {
          if (agent.slotId && agent.agentName) {
            slotToName.set(agent.slotId, agent.agentName);
          }
        }
      } catch {
        // Skip malformed agents JSON
      }
    }

    // Update team_tasks.owner from slotId to agentName where applicable
    let normalized = 0;
    for (const [slotId, agentName] of slotToName) {
      const result = db.prepare('UPDATE team_tasks SET owner = ? WHERE owner = ?').run(agentName, slotId);
      normalized += result.changes;
    }

    console.log(
      `[Migration-v56] Added progress_notes column. Normalized ${String(normalized)} task owners to agentName.`
    );
  },
  down(_db: ISqliteDriver) {
    console.warn('[Migration-v56] Rollback: columns remain (SQLite limitation).');
    void _db;
  },
};

// ── Phase 13: Fix persisted agent status from 'pending' to 'idle' ────────────

const migration_v57: IMigration = {
  version: 57,
  name: 'Fix persisted agent status: pending → idle in teams.agents JSON',
  up(db: ISqliteDriver) {
    const teams = db.prepare('SELECT id, agents FROM teams').all() as Array<{ id: string; agents: string }>;
    let fixed = 0;

    for (const team of teams) {
      try {
        const agents = JSON.parse(team.agents) as Array<{ status: string; agentName?: string }>;
        let changed = false;
        for (const agent of agents) {
          if (agent.status === 'pending') {
            agent.status = 'idle';
            changed = true;
          }
        }
        if (changed) {
          db.prepare('UPDATE teams SET agents = ?, updated_at = ? WHERE id = ?').run(
            JSON.stringify(agents),
            Date.now(),
            team.id
          );
          fixed++;
        }
      } catch {
        // Skip malformed agents JSON
      }
    }

    console.log(`[Migration-v57] Fixed agent status pending→idle in ${String(fixed)} of ${String(teams.length)} teams`);
  },
  down(_db: ISqliteDriver) {
    // Status change is harmless — no rollback needed
    void _db;
  },
};

// ── Phase 14: Allow pruning of old activity_log entries ──────────────────────

const migration_v58: IMigration = {
  version: 58,
  name: 'Replace immutable activity_log trigger with retention-aware trigger',
  up(db: ISqliteDriver) {
    // Drop the blanket immutable trigger that blocks ALL deletes
    db.exec('DROP TRIGGER IF EXISTS prevent_activity_log_delete');

    // Re-create with a 7-day safety window: only block deletes of entries < 7 days old.
    // The pruning service deletes entries > 30 days — this trigger protects recent data
    // from accidental deletion while allowing old data to be pruned.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_activity_log_delete_recent
      BEFORE DELETE ON activity_log
      WHEN OLD.created_at > (strftime('%s', 'now') * 1000 - 7 * 24 * 60 * 60 * 1000)
      BEGIN
        SELECT RAISE(ABORT, 'activity_log: cannot delete entries less than 7 days old');
      END
    `);

    console.log('[Migration-v58] Replaced immutable trigger with 7-day retention trigger');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP TRIGGER IF EXISTS prevent_activity_log_delete_recent');
    // Restore blanket immutable trigger
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS prevent_activity_log_delete
      BEFORE DELETE ON activity_log
      BEGIN
        SELECT RAISE(ABORT, 'activity_log is immutable: deletes are not allowed');
      END
    `);
  },
};

// ── Phase 15: composite indexes for hot query paths ──────────────────────────

const migration_v59: IMigration = {
  version: 59,
  name: 'Add composite indexes for activity_log governance filters and sprint_tasks board loads',
  up(db: ISqliteDriver) {
    // Activity log: governance page filters by user + entity type over recent window.
    // This composite makes "latest N entries for user X of type Y" an index-only scan.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activity_log_user_entity_date
      ON activity_log(user_id, entity_type, created_at DESC)
    `);
    // Sprint tasks: Mission Control + Sprint Board query "open tasks for team X ordered by date"
    // many times per minute. Composite makes this an index-only scan even with 100+ tasks.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sprint_tasks_team_status
      ON sprint_tasks(team_id, status, created_at DESC)
    `);
    console.log('[Migration-v59] Created composite indexes for activity_log + sprint_tasks');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_activity_log_user_entity_date');
    db.exec('DROP INDEX IF EXISTS idx_sprint_tasks_team_status');
  },
};

// ── Phase 16 (v1.9.26): fleet mode feature flag ────────────────────────────

const migration_v60: IMigration = {
  version: 60,
  name: 'Register fleet_mode_enabled feature flag (default ON)',
  up(db: ISqliteDriver) {
    // Seed fleet_mode_enabled = 1 so v1.9.26+ installs boot into the
    // setup wizard by default. Admins can disable post-install from
    // the Governance UI (Security Dashboard tab) if they need to roll
    // back to pre-fleet behavior across the team.
    db.prepare('INSERT OR IGNORE INTO security_feature_toggles (feature, enabled, updated_at) VALUES (?, 1, ?)').run(
      'fleet_mode_enabled',
      Date.now()
    );
    console.log('[Migration-v60] Registered fleet_mode_enabled feature flag (default ON)');
  },
  down(db: ISqliteDriver) {
    db.prepare('DELETE FROM security_feature_toggles WHERE feature = ?').run('fleet_mode_enabled');
  },
};

// ── Phase 17 (v1.9.27): fleet enrollment tables ────────────────────────────

const migration_v61: IMigration = {
  version: 61,
  name: 'Create fleet_enrollments + fleet_enrollment_tokens for Phase B enrollment',
  up(db: ISqliteDriver) {
    // One-time enrollment tokens generated by the master's admin UI.
    // Plaintext is NEVER stored — only the SHA256 hash. The admin is
    // shown the plaintext once at generation time and expected to
    // paste it into the slave's setup wizard; after that, the token
    // is consumed on `POST /api/fleet/enroll` by looking up the hash.
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_enrollment_tokens (
      token_hash TEXT PRIMARY KEY,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      issued_by TEXT NOT NULL,
      used_at INTEGER,
      used_by_device_id TEXT,
      revoked_at INTEGER,
      note TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_enrollment_tokens_expires ON fleet_enrollment_tokens(expires_at)');

    // The device roster. device_id is derived from the slave's Ed25519
    // public key (SHA256 fingerprint — same formula as deviceIdentity
    // service uses locally on each slave). Storing the full pubkey PEM
    // enables signature verification on subsequent requests without
    // a round-trip.
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_enrollments (
      device_id TEXT PRIMARY KEY,
      device_pubkey_pem TEXT NOT NULL,
      hostname TEXT NOT NULL,
      os_version TEXT NOT NULL,
      titanx_version TEXT NOT NULL,
      enrolled_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER,
      status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'revoked')),
      revoked_at INTEGER,
      device_jwt_jti TEXT NOT NULL,
      enrollment_token_hash TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_enrollments_status ON fleet_enrollments(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_enrollments_heartbeat ON fleet_enrollments(last_heartbeat_at DESC)');

    console.log('[Migration-v61] Created fleet_enrollments + fleet_enrollment_tokens tables');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_fleet_enrollment_tokens_expires');
    db.exec('DROP INDEX IF EXISTS idx_fleet_enrollments_status');
    db.exec('DROP INDEX IF EXISTS idx_fleet_enrollments_heartbeat');
    db.exec('DROP TABLE IF EXISTS fleet_enrollments');
    db.exec('DROP TABLE IF EXISTS fleet_enrollment_tokens');
  },
};

// ── Phase 18 (v1.9.28): fleet config sync version + managed-key tracking ──

const migration_v62: IMigration = {
  version: 62,
  name: 'Create fleet_config_version + managed_config_keys for Phase C config sync',
  up(db: ISqliteDriver) {
    // Monotonic version number that bumps on every mutation to a
    // master-controlled table (iam_policies + security_feature_toggles
    // today; agent_gallery + managed settings in Phase E). Slaves pull
    // the full bundle when their local version < master version.
    //
    // Singleton row pattern: id is hardcoded to 1 via CHECK so we
    // can't accidentally end up with multiple version rows.
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_config_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    )`);
    db.prepare(
      'INSERT OR IGNORE INTO fleet_config_version (id, version, updated_at, updated_by) VALUES (1, 0, ?, ?)'
    ).run(Date.now(), 'system');

    // Slave-side inventory of which ProcessConfig keys are currently
    // under master control. The UI renders these with a lock icon +
    // "Controlled by IT" tooltip; the IPC layer blocks local writes
    // to any key listed here.
    //
    // `previous_value` retains the user's pre-managed setting as a
    // JSON blob so we can restore it if the slave unenrolls cleanly.
    db.exec(`CREATE TABLE IF NOT EXISTS managed_config_keys (
      key TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'master',
      managed_by_version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      previous_value TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_managed_config_keys_version ON managed_config_keys(managed_by_version)');

    console.log('[Migration-v62] Created fleet_config_version + managed_config_keys');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_managed_config_keys_version');
    db.exec('DROP TABLE IF EXISTS managed_config_keys');
    db.exec('DROP TABLE IF EXISTS fleet_config_version');
  },
};

const migration_v63: IMigration = {
  version: 63,
  name: 'Add source + managed_by_version columns to iam_policies and security_feature_toggles',
  up(db: ISqliteDriver) {
    // source = 'local' means user-created on this machine
    // source = 'master' means pushed from master (slave-side after sync)
    // source = 'builtin' means seeded by migration (e.g. default feature flags)
    const addIfMissing = (table: string, column: string, decl: string): void => {
      const cols = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };

    addIfMissing('iam_policies', 'source', "TEXT NOT NULL DEFAULT 'local'");
    addIfMissing('iam_policies', 'managed_by_version', 'INTEGER');

    addIfMissing('security_feature_toggles', 'source', "TEXT NOT NULL DEFAULT 'local'");
    addIfMissing('security_feature_toggles', 'managed_by_version', 'INTEGER');

    console.log('[Migration-v63] Added source + managed_by_version to iam_policies + security_feature_toggles');
  },
  down(_db: ISqliteDriver) {
    // SQLite pre-3.35 doesn't support DROP COLUMN cleanly; leave the
    // columns behind on downgrade (same approach as v56). They're
    // NULL-safe and don't affect pre-Phase-C code.
    console.warn('[Migration-v63] Rollback: columns remain (SQLite limitation)');
  },
};

// ────────────────────────────────────────────────────────────────────────
// Phase D Week 1 — Fleet telemetry aggregation (v1.9.32)
// ────────────────────────────────────────────────────────────────────────

/**
 * Master-side table holding reports pushed by slaves. One row per
 * (device, report window). Idempotent upsert keyed on those two columns
 * lets slaves safely retry a push without double-counting.
 *
 * `report_payload` holds the full JSON for future fields we haven't
 * promoted to top-level columns yet — forward-compat for richer dashboards.
 */
const migration_v64: IMigration = {
  version: 64,
  name: 'Create fleet_telemetry_reports for Phase D telemetry aggregation',
  up(db: ISqliteDriver) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_telemetry_reports (
      device_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      total_cost_cents INTEGER NOT NULL DEFAULT 0,
      activity_count INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      policy_violation_count INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      report_payload TEXT NOT NULL DEFAULT '{}',
      received_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, window_end)
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fleet_telemetry_reports_device ON fleet_telemetry_reports(device_id, window_end DESC)'
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fleet_telemetry_reports_window ON fleet_telemetry_reports(window_end DESC)'
    );
    console.log('[Migration-v64] Created fleet_telemetry_reports');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_fleet_telemetry_reports_window');
    db.exec('DROP INDEX IF EXISTS idx_fleet_telemetry_reports_device');
    db.exec('DROP TABLE IF EXISTS fleet_telemetry_reports');
  },
};

/**
 * Slave-side singleton tracking the last report window successfully
 * acked by master. Used by the push loop to pick the next `since`
 * boundary without reporting overlapping windows.
 */
const migration_v65: IMigration = {
  version: 65,
  name: 'Create fleet_telemetry_state (slave singleton) for Phase D',
  up(db: ISqliteDriver) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_telemetry_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_report_window_end INTEGER NOT NULL DEFAULT 0,
      last_push_at INTEGER,
      last_push_error TEXT,
      updated_at INTEGER NOT NULL
    )`);
    db.prepare(
      'INSERT OR IGNORE INTO fleet_telemetry_state (id, last_report_window_end, updated_at) VALUES (1, 0, ?)'
    ).run(Date.now());
    console.log('[Migration-v65] Created fleet_telemetry_state singleton');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP TABLE IF EXISTS fleet_telemetry_state');
  },
};

// ────────────────────────────────────────────────────────────────────────
// Phase E Week 1 — Agent template distribution (v1.9.33+)
// ────────────────────────────────────────────────────────────────────────

/**
 * Extends agent_gallery with the same three columns Phase C added to
 * iam_policies / security_feature_toggles (v63), plus a dedicated
 * `published_to_fleet` flag that master admins flip to "push this
 * template down to all slaves".
 *
 * Semantics:
 *   - source='local' (default): created on this machine, lives here
 *   - source='master': pushed from master via a fleet bundle (slave side)
 *   - source='builtin': seeded by a migration (no rows flag this yet
 *     for agent_gallery, but the column keeps the vocabulary consistent
 *     with iam_policies)
 *   - published_to_fleet: master-side curation flag — governs whether
 *     buildConfigBundle() includes this template in the push payload.
 *     Orthogonal to the pre-existing `published` column (which governs
 *     whether the template is visible in the user's own gallery).
 */
const migration_v66: IMigration = {
  version: 66,
  name: 'Add source + managed_by_version + published_to_fleet columns to agent_gallery',
  up(db: ISqliteDriver) {
    const addIfMissing = (table: string, column: string, decl: string): void => {
      const cols = new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    };

    addIfMissing('agent_gallery', 'source', "TEXT NOT NULL DEFAULT 'local'");
    addIfMissing('agent_gallery', 'managed_by_version', 'INTEGER');
    addIfMissing('agent_gallery', 'published_to_fleet', 'INTEGER NOT NULL DEFAULT 0');

    console.log('[Migration-v66] Added source + managed_by_version + published_to_fleet to agent_gallery');
  },
  down(_db: ISqliteDriver) {
    // SQLite pre-3.35 can't DROP COLUMN cleanly; columns stay behind
    // on downgrade. NULL-safe, so older code paths keep working.
    console.warn('[Migration-v66] Rollback: columns remain (SQLite limitation)');
  },
};

// ────────────────────────────────────────────────────────────────────────
// Phase F Week 1 — Remote commands (v1.9.35)
// ────────────────────────────────────────────────────────────────────────

/**
 * Master-side command queue + slave-side ack trail. Two tables:
 *
 *   fleet_commands: master enqueues commands here. Slaves pull the
 *   subset addressed to them (or to 'all') piggybacked on every
 *   heartbeat response. Commands expire via `expires_at` so a
 *   forgotten command doesn't fire weeks later when a stale device
 *   reconnects.
 *
 *   fleet_command_acks: slaves POST back the outcome of each command
 *   they executed. Composite PK (command_id, device_id) makes replays
 *   idempotent — a slave retrying an ack updates its row rather than
 *   creating a duplicate.
 *
 * Why two tables instead of one with status column? Because a command
 * targeted at 'all' fans out to N devices, each of which acks
 * independently. Storing the ack per-device in its own row lets the
 * admin dashboard render "13 of 15 devices acked" without a JSON blob.
 *
 * Phase F v1 ships with non-destructive command types only
 * (force_config_sync, force_telemetry_push). The schema is intentionally
 * open-ended via `params TEXT` (JSON) so adding new command types
 * doesn't require a migration.
 */
const migration_v67: IMigration = {
  version: 67,
  name: 'Create fleet_commands + fleet_command_acks for Phase F remote commands',
  up(db: ISqliteDriver) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_commands (
      id TEXT PRIMARY KEY,
      target_device_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
    // Hot path: slave asks "anything for me right now?" — index on
    // target_device_id + expires_at so the WHERE clause is O(log n).
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fleet_commands_target_expires ON fleet_commands(target_device_id, expires_at DESC)'
    );
    // Admin dashboard: list recent commands newest-first.
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_commands_created ON fleet_commands(created_at DESC)');

    db.exec(`CREATE TABLE IF NOT EXISTS fleet_command_acks (
      command_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '{}',
      acked_at INTEGER NOT NULL,
      PRIMARY KEY (command_id, device_id)
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fleet_command_acks_command ON fleet_command_acks(command_id, acked_at DESC)'
    );

    console.log('[Migration-v67] Created fleet_commands + fleet_command_acks');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_fleet_command_acks_command');
    db.exec('DROP TABLE IF EXISTS fleet_command_acks');
    db.exec('DROP INDEX IF EXISTS idx_fleet_commands_created');
    db.exec('DROP INDEX IF EXISTS idx_fleet_commands_target_expires');
    db.exec('DROP TABLE IF EXISTS fleet_commands');
  },
};

// ────────────────────────────────────────────────────────────────────────
// Phase F.2 Week 1 — Destructive command signing + replay prevention
// ────────────────────────────────────────────────────────────────────────

/**
 * Two new tables, one per role:
 *
 * fleet_master_signing_key (master-only, singleton):
 *   The master's Ed25519 keypair for signing destructive commands.
 *   Private key is encrypted at rest via the secrets vault (same
 *   pattern as deviceIdentity). Public key goes out to slaves in the
 *   enrollment response so they can verify signatures.
 *
 *   Rotating this key revokes every prior destructive command
 *   automatically — slaves with the old pubkey refuse signatures
 *   from the new one, so any in-flight replay dies on arrival.
 *
 * fleet_command_replay_nonces (slave-only):
 *   Every destructive command envelope carries a random 16-byte
 *   nonce. Slaves record it here on first execution; a second
 *   arrival with the same nonce gets rejected. Nonces older than
 *   NONCE_RETENTION_MS are swept (bounded table size) but that
 *   window must exceed the max command TTL or we re-enable replay.
 */
const migration_v68: IMigration = {
  version: 68,
  name: 'Create fleet_master_signing_key + fleet_command_replay_nonces for Phase F.2',
  up(db: ISqliteDriver) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_master_signing_key (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key_pem TEXT NOT NULL,
      private_key_ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS fleet_command_replay_nonces (
      nonce TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL,
      command_id TEXT NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_command_replay_nonces_seen ON fleet_command_replay_nonces(seen_at)');

    console.log('[Migration-v68] Created fleet_master_signing_key + fleet_command_replay_nonces');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_fleet_command_replay_nonces_seen');
    db.exec('DROP TABLE IF EXISTS fleet_command_replay_nonces');
    db.exec('DROP TABLE IF EXISTS fleet_master_signing_key');
  },
};

/**
 * v69 — Phase B (Agent Farm) data model (v1.10.0).
 *
 * fleet_farm_devices (master + slave):
 *   Extends fleet_enrollments with a role declaration. Role is set at
 *   enroll time and locked thereafter (re-enrollment required to swap).
 *   Keeping this in a side table rather than a column on fleet_enrollments
 *   means the original enrollment row stays untouched by the migration —
 *   minimizes regression surface on the already-shipped workforce path.
 *
 * fleet_agent_jobs (master + slave):
 *   A log of every agent.execute dispatch. Master uses it as the
 *   source-of-truth for job state (queued → dispatched → running →
 *   completed/failed/timeout). Slave mirrors the row so telemetry
 *   aggregation can run locally without requiring master replay.
 *
 *   Both sides use the same schema so the same queries work on both
 *   without a split code path.
 */
const migration_v69: IMigration = {
  version: 69,
  name: 'Create fleet_farm_devices + fleet_agent_jobs for Phase B Agent Farm (v1.10.0)',
  up(db: ISqliteDriver) {
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_farm_devices (
      device_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('workforce','farm')) DEFAULT 'workforce',
      capabilities TEXT NOT NULL DEFAULT '{}',
      compute_budget_cents INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS fleet_agent_jobs (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      agent_slot_id TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      response_payload TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','dispatched','running','completed','failed','timeout')),
      error TEXT,
      enqueued_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      completed_at INTEGER
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fleet_jobs_device_status ON fleet_agent_jobs(device_id, status, enqueued_at)'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_jobs_team ON fleet_agent_jobs(team_id, agent_slot_id)');

    console.log('[Migration-v69] Created fleet_farm_devices + fleet_agent_jobs for Agent Farm');
  },
  down(db: ISqliteDriver) {
    db.exec('DROP INDEX IF EXISTS idx_fleet_jobs_team');
    db.exec('DROP INDEX IF EXISTS idx_fleet_jobs_device_status');
    db.exec('DROP TABLE IF EXISTS fleet_agent_jobs');
    db.exec('DROP TABLE IF EXISTS fleet_farm_devices');
  },
};

/**
 * v70 — Phase C (Dream Mode) data model (v1.11.0).
 *
 * learning_exports (slave-only):
 *   Tracks which reasoning_bank + agent_memory rows have been pushed
 *   to master as consolidation fodder. Without this table the slave
 *   would re-push the same trajectory on every 24h cycle, so master
 *   would see duplicates AND the slave would burn bandwidth. Keying
 *   by (source_table, source_id, window_end) makes the "have I pushed
 *   this specific row for this window?" check an O(1) index lookup.
 *
 *   Partial index on pushed_at IS NULL gives the worker a cheap way
 *   to find "what's unsent" without scanning the full table.
 *
 * fleet_learnings (master-only):
 *   Per-device shards of slave-pushed learnings. Each row is one
 *   trajectory OR one memory-summary blob; the dream scheduler buckets
 *   by trajectory_hash (for trajectories) and by content-hash (for
 *   memory summaries) across devices when it consolidates.
 *
 *   consolidated_version is NULL until the dream scheduler merges the
 *   row into a consolidation run — the partial index on that predicate
 *   gives the scheduler a cheap "what's new since last run" query.
 *
 * consolidated_learnings (master-only):
 *   Output of each dream pass. version is monotonic; payload is the
 *   JSON array of DistilledTrajectory entries that gets embedded in
 *   the next config bundle + broadcast back to slaves.
 *
 * reasoning_bank.source_tag (slave-only new column):
 *   Distinguishes locally-minted trajectories from master-broadcast
 *   consolidated ones. Without this split, the slave's pruning pass
 *   could delete consolidated rows by accident (usage_count=0 on first
 *   receive) and the next config pull would re-sync them, thrashing.
 *   Default NULL = locally minted. 'fleet_consolidated' = master push.
 */
const migration_v70: IMigration = {
  version: 70,
  name: 'Create learning_exports + fleet_learnings + consolidated_learnings for Phase C Dream Mode (v1.11.0)',
  up(db: ISqliteDriver) {
    // Slave-only: export tracking. Master installs create this table
    // too but never write to it — simpler than a split-schema migration.
    db.exec(`CREATE TABLE IF NOT EXISTS learning_exports (
      id TEXT PRIMARY KEY,
      source_table TEXT NOT NULL CHECK(source_table IN ('reasoning_bank','agent_memory')),
      source_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      pushed_at INTEGER,
      ack_version INTEGER,
      UNIQUE(source_table, source_id, window_end)
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_learning_exports_unpushed ON learning_exports(pushed_at) WHERE pushed_at IS NULL'
    );

    // Master-only: ingested shards from slaves. Rows accumulate until
    // the next dream pass consolidates them.
    db.exec(`CREATE TABLE IF NOT EXISTS fleet_learnings (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      learning_type TEXT NOT NULL CHECK(learning_type IN ('trajectory','memory_summary')),
      payload TEXT NOT NULL,
      success_score REAL,
      usage_count_local INTEGER,
      received_at INTEGER NOT NULL,
      consolidated_version INTEGER
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_fleet_learnings_unconsolidated ON fleet_learnings(consolidated_version) WHERE consolidated_version IS NULL'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_learnings_device ON fleet_learnings(device_id, received_at DESC)');

    // Master-only: consolidated output, versioned. Latest row's payload
    // ships in the next config bundle.
    db.exec(`CREATE TABLE IF NOT EXISTS consolidated_learnings (
      version INTEGER PRIMARY KEY,
      published_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      trajectory_count INTEGER NOT NULL DEFAULT 0,
      contributing_devices INTEGER NOT NULL DEFAULT 0
    )`);

    // Slave-only new column on reasoning_bank. Default NULL keeps
    // existing rows classified as locally-minted with zero backfill.
    // SQLite ALTER TABLE ADD COLUMN is atomic, idempotent-safe via
    // try/catch: if we re-run the migration on a partial state the
    // column may already exist.
    try {
      db.exec(`ALTER TABLE reasoning_bank ADD COLUMN source_tag TEXT`);
    } catch (e) {
      // Only 'duplicate column name' is expected here; anything else
      // is a real error and should surface. SQLite's err message format
      // is stable ("duplicate column name: source_tag").
      const msg = e instanceof Error ? e.message : String(e);
      if (!/duplicate column name/i.test(msg)) throw e;
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_reasoning_bank_source_tag ON reasoning_bank(source_tag) WHERE source_tag IS NOT NULL'
    );

    console.log(
      '[Migration-v70] Created learning_exports + fleet_learnings + consolidated_learnings + reasoning_bank.source_tag for Dream Mode'
    );
  },
  down(db: ISqliteDriver) {
    // Note: ALTER TABLE DROP COLUMN is SQLite 3.35+. Skip the column
    // drop on rollback — nulled values are harmless, and rolling back
    // past a dream-mode release should be rare enough that manual
    // cleanup is acceptable.
    db.exec('DROP INDEX IF EXISTS idx_reasoning_bank_source_tag');
    db.exec('DROP TABLE IF EXISTS consolidated_learnings');
    db.exec('DROP INDEX IF EXISTS idx_fleet_learnings_device');
    db.exec('DROP INDEX IF EXISTS idx_fleet_learnings_unconsolidated');
    db.exec('DROP TABLE IF EXISTS fleet_learnings');
    db.exec('DROP INDEX IF EXISTS idx_learning_exports_unpushed');
    db.exec('DROP TABLE IF EXISTS learning_exports');
  },
};

// prettier-ignore
export const ALL_MIGRATIONS: IMigration[] = [
  migration_v1, migration_v2, migration_v3, migration_v4, migration_v5, migration_v6,
  migration_v7, migration_v8, migration_v9, migration_v10, migration_v11, migration_v12,
  migration_v13, migration_v14, migration_v15, migration_v16, migration_v17, migration_v18,
  migration_v19, migration_v20, migration_v21, migration_v22,
  migration_v23, migration_v24, migration_v25,
  migration_v26, migration_v27, migration_v28, migration_v29,
  migration_v30, migration_v31, migration_v32, migration_v33, migration_v34,
  migration_v35, migration_v36, migration_v37, migration_v38, migration_v39,
  migration_v40, migration_v41, migration_v42, migration_v43, migration_v44,
  migration_v45, migration_v46, migration_v47, migration_v48, migration_v49, migration_v50, migration_v51, migration_v52, migration_v53,
  migration_v54, migration_v55, migration_v56, migration_v57, migration_v58, migration_v59,
  migration_v60, migration_v61, migration_v62, migration_v63, migration_v64, migration_v65,
  migration_v66, migration_v67, migration_v68, migration_v69, migration_v70,
];

/**
 * Get migrations needed to upgrade from one version to another
 */
export function getMigrationsToRun(fromVersion: number, toVersion: number): IMigration[] {
  return ALL_MIGRATIONS.filter((m) => m.version > fromVersion && m.version <= toVersion).toSorted(
    (a, b) => a.version - b.version
  );
}

/**
 * Get migrations needed to downgrade from one version to another
 */
export function getMigrationsToRollback(fromVersion: number, toVersion: number): IMigration[] {
  return ALL_MIGRATIONS.filter((m) => m.version > toVersion && m.version <= fromVersion).toSorted(
    (a, b) => b.version - a.version
  );
}

/**
 * Run migrations in a transaction
 */
export function runMigrations(db: ISqliteDriver, fromVersion: number, toVersion: number): void {
  if (fromVersion === toVersion) {
    console.log('[Migrations] Already at target version');
    return;
  }

  if (fromVersion > toVersion) {
    throw new Error(`[Migrations] Downgrade not supported in production. Use rollbackMigration() for testing only.`);
  }

  const migrations = getMigrationsToRun(fromVersion, toVersion);

  if (migrations.length === 0) {
    console.log(`[Migrations] No migrations needed from v${fromVersion} to v${toVersion}`);
    return;
  }

  console.log(`[Migrations] Running ${migrations.length} migrations from v${fromVersion} to v${toVersion}`);

  // Disable foreign keys BEFORE the transaction to allow table recreation
  // (DROP TABLE + CREATE TABLE). PRAGMA foreign_keys cannot be changed inside
  // a transaction — it is silently ignored.
  // See: https://www.sqlite.org/lang_altertable.html#otheralter
  db.pragma('foreign_keys = OFF');

  // Run all migrations in a single transaction
  const runAll = db.transaction(() => {
    for (const migration of migrations) {
      try {
        console.log(`[Migrations] Running migration v${migration.version}: ${migration.name}`);
        migration.up(db);

        console.log(`[Migrations] ✓ Migration v${migration.version} completed`);
      } catch (error) {
        console.error(`[Migrations] ✗ Migration v${migration.version} failed:`, error);
        throw error; // Transaction will rollback
      }
    }

    // Verify foreign key integrity after all migrations
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      console.error('[Migrations] Foreign key violations detected:', fkViolations);
      throw new Error(`[Migrations] Foreign key check failed: ${fkViolations.length} violation(s)`);
    }
  });

  try {
    runAll();
    console.log(`[Migrations] All migrations completed successfully`);
  } catch (error) {
    console.error('[Migrations] Migration failed, all changes rolled back:', error);
    throw error;
  } finally {
    // Re-enable foreign keys regardless of success or failure
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Rollback migrations (for testing/emergency use)
 * WARNING: This can cause data loss!
 */
export function rollbackMigrations(db: ISqliteDriver, fromVersion: number, toVersion: number): void {
  if (fromVersion <= toVersion) {
    throw new Error('[Migrations] Cannot rollback to a higher or equal version');
  }

  const migrations = getMigrationsToRollback(fromVersion, toVersion);

  if (migrations.length === 0) {
    console.log(`[Migrations] No rollback needed from v${fromVersion} to v${toVersion}`);
    return;
  }

  console.log(`[Migrations] Rolling back ${migrations.length} migrations from v${fromVersion} to v${toVersion}`);
  console.warn('[Migrations] WARNING: This may cause data loss!');

  // Disable foreign keys BEFORE the transaction (same reason as runMigrations)
  db.pragma('foreign_keys = OFF');

  // Run all rollbacks in a single transaction
  const rollbackAll = db.transaction(() => {
    for (const migration of migrations) {
      try {
        console.log(`[Migrations] Rolling back migration v${migration.version}: ${migration.name}`);
        migration.down(db);

        console.log(`[Migrations] ✓ Rollback v${migration.version} completed`);
      } catch (error) {
        console.error(`[Migrations] ✗ Rollback v${migration.version} failed:`, error);
        throw error; // Transaction will rollback
      }
    }

    // Verify foreign key integrity after rollback
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    if (fkViolations.length > 0) {
      console.error('[Migrations] Foreign key violations detected after rollback:', fkViolations);
      throw new Error(`[Migrations] Foreign key check failed: ${fkViolations.length} violation(s)`);
    }
  });

  try {
    rollbackAll();
    console.log(`[Migrations] All rollbacks completed successfully`);
  } catch (error) {
    console.error('[Migrations] Rollback failed:', error);
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Get migration history
 * Now simplified - just returns the current version
 */
export function getMigrationHistory(db: ISqliteDriver): Array<{ version: number; name: string; timestamp: number }> {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  // Return a simple array with just the current version
  return [
    {
      version: currentVersion,
      name: `Current schema version`,
      timestamp: Date.now(),
    },
  ];
}

/**
 * Check if a specific migration has been applied
 * Now simplified - checks if current version >= target version
 */
export function isMigrationApplied(db: ISqliteDriver, version: number): boolean {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  return currentVersion >= version;
}
