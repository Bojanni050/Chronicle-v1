const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { SalienceDecayService } = require('./services/salienceDecayService');

// Initialize PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive'
});

// Initialize Salience Decay Service
let salienceDecayService = null;

let mainWindow;

// Retry configuration for database connection
const RETRY_CONFIG = {
  maxRetries: 10,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2
};

/**
 * Sleep helper for delay between retries
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Database Initialization for PostgreSQL with retry logic
 */
async function initDatabase() {
  let lastError;
  let delay = RETRY_CONFIG.initialDelayMs;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      console.log(`[Chronicle] Database connection attempt ${attempt}/${RETRY_CONFIG.maxRetries}...`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create core table with assets column
        await client.query(`
          CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            type TEXT DEFAULT 'chat',
            title TEXT,
            content TEXT,
            summary TEXT,
            tags JSONB,
            source TEXT,
            createdAt BIGINT,
            updatedAt BIGINT,
            fileName TEXT,
            embedding vector(1536),
            assets JSONB DEFAULT '[]',
            memory_type TEXT,
            salience double precision
          )
        `);

        // Create Links Table
        await client.query(`
          CREATE TABLE IF NOT EXISTS links (
            id SERIAL PRIMARY KEY,
            from_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            to_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            link_type TEXT,
            created_at BIGINT,
            UNIQUE(from_id, to_id)
          )
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS facts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            confidence FLOAT DEFAULT 1.0,
            salience FLOAT DEFAULT 0.5,
            valid_from TIMESTAMPTZ DEFAULT NOW(),
            valid_to TIMESTAMPTZ,
            created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
          )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_facts_chat_id ON facts(chat_id)');
        await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS salience FLOAT DEFAULT 0.4');
        await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS recall_count INTEGER DEFAULT 0');
        
        // Salience decay tracking columns
        await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT');
        await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS decay_metadata JSONB DEFAULT \'{}\'');
        await client.query('ALTER TABLE facts ADD COLUMN IF NOT EXISTS last_accessed_at BIGINT');
        await client.query('ALTER TABLE facts ADD COLUMN IF NOT EXISTS recall_count INTEGER DEFAULT 0');
        await client.query('ALTER TABLE facts ADD COLUMN IF NOT EXISTS decay_metadata JSONB DEFAULT \'{}\'');
        
        // Create salience decay metrics table
        await client.query(`
          CREATE TABLE IF NOT EXISTS salience_decay_metrics (
            id SERIAL PRIMARY KEY,
            run_timestamp TIMESTAMPTZ DEFAULT NOW(),
            items_processed INTEGER DEFAULT 0,
            items_decayed INTEGER DEFAULT 0,
            average_decay_amount FLOAT DEFAULT 0,
            memory_entropy FLOAT DEFAULT 0,
            environmental_context TEXT,
            processing_duration_ms INTEGER,
            error_count INTEGER DEFAULT 0
          )
        `);
        
        // Indexes for efficient decay queries
        await client.query('CREATE INDEX IF NOT EXISTS idx_chats_last_accessed ON chats(last_accessed_at) WHERE salience > 0.1');
        await client.query('CREATE INDEX IF NOT EXISTS idx_facts_last_accessed ON facts(last_accessed_at) WHERE salience > 0.1');
        await client.query('CREATE INDEX IF NOT EXISTS idx_decay_metrics_timestamp ON salience_decay_metrics(run_timestamp DESC)');

        // Optimized Indexes
        await client.query('CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(createdAt DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_chats_source ON chats(source)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type)');

        // Enable pgvector and ensure vector index exists for semantic search
        await client.query('CREATE EXTENSION IF NOT EXISTS vector');
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relname = 'idx_chats_embedding_ivfflat'
            ) THEN
              EXECUTE 'CREATE INDEX idx_chats_embedding_ivfflat ON chats USING hnsw (embedding vector_cosine_ops)';
            END IF;
          END $$;
        `);

        await client.query('COMMIT');
        console.log('[Chronicle] PostgreSQL Schema verified successfully.');
        return; // Success - exit retry loop
      } catch (err) {
        await client.query('ROLLBACK');
        throw err; // Re-throw to be caught by outer retry logic
      } finally {
        client.release();
      }
    } catch (err) {
      lastError = err;

      // Only retry on connection errors, not schema/SQL errors
      const isConnectionError = err.code === 'ECONNREFUSED' ||
                                err.code === 'ETIMEDOUT' ||
                                err.code === 'ECONNRESET' ||
                                err.code === '08000' ||  // connection_exception
                                err.code === '08003' ||  // connection_does_not_exist
                                err.code === '08006';   // connection_failure

      if (!isConnectionError) {
        console.error('[Chronicle] DB Schema Error (non-retryable):', err.message);
        throw err; // Don't retry schema/SQL errors
      }

      console.error(`[Chronicle] DB connection error (attempt ${attempt}/${RETRY_CONFIG.maxRetries}):`, err.message);

      if (attempt < RETRY_CONFIG.maxRetries) {
        console.log(`[Chronicle] Retrying in ${delay}ms...`);
        await sleep(delay);
        delay = Math.min(delay * RETRY_CONFIG.backoffMultiplier, RETRY_CONFIG.maxDelayMs);
      }
    }
  }

  // All retries exhausted
  console.error('[Chronicle] Failed to initialize database after all retries.');
  throw lastError;
}

// IPC Handlers
ipcMain.handle('save-database', async (event, items) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(`
        INSERT INTO chats (id, type, title, content, summary, tags, source, createdAt, updatedAt, fileName, embedding, assets, memory_type, salience)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          summary = EXCLUDED.summary,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          updatedAt = EXCLUDED.updatedAt,
          embedding = EXCLUDED.embedding,
          assets = EXCLUDED.assets,
          memory_type = EXCLUDED.memory_type,
          salience = EXCLUDED.salience
      `, [
        item.id,
        item.type || 'chat',
        item.title,
        item.content,
        item.summary,
        JSON.stringify(item.tags),
        item.source,
        item.createdAt,
        item.updatedAt || item.createdAt,
        item.fileName,
        item.embedding,
        JSON.stringify(item.assets || []),
        item.memory_type || null,
        typeof item.salience === 'number' ? item.salience : null
      ]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] Save Error:', err);
    return false;
  } finally {
    client.release();
  }
});

ipcMain.handle('load-database', async () => {
  try {
    const res = await pool.query('SELECT * FROM chats ORDER BY createdAt DESC');
    return res.rows.map(r => ({
      ...r,
      createdAt: Number(r.createdat),
      updatedAt: Number(r.updatedat),
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
      assets: typeof r.assets === 'string' ? JSON.parse(r.assets) : r.assets,
      embedding: r.embedding,
      memory_type: r.memory_type || null,
      salience: r.salience !== undefined && r.salience !== null ? Number(r.salience) : null
    }));
  } catch (err) {
    console.error('[Chronicle] Load Error:', err);
    return [];
  }
});

ipcMain.handle('save-facts', async (event, chatId, facts) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const fact of facts) {
      await client.query(
        'UPDATE facts SET valid_to = NOW() WHERE subject = $1 AND predicate = $2 AND valid_to IS NULL AND id <> $3',
        [fact.subject, fact.predicate, fact.id || '00000000-0000-0000-0000-000000000000']
      );
      await client.query(
        'INSERT INTO facts (chat_id, subject, predicate, object, confidence, salience) VALUES ($1, $2, $3, $4, $5, 0.5) ON CONFLICT DO NOTHING',
        [chatId, fact.subject, fact.predicate, fact.object, typeof fact.confidence === 'number' ? fact.confidence : 1.0]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] Save facts error:', err);
    return false;
  } finally {
    client.release();
  }
});

ipcMain.handle('boost-salience', async (event, chatId) => {
  try {
    const currentTime = Date.now();
    
    // Update salience and recall count, and reset decay timer
    await pool.query(
      `UPDATE chats 
       SET salience = LEAST(salience + 0.05, 1.0), 
           recall_count = COALESCE(recall_count, 0) + 1,
           last_accessed_at = $2
       WHERE id = $1`,
      [chatId, currentTime]
    );
    
    await pool.query(
      `UPDATE facts 
       SET salience = LEAST(salience + 0.03, 1.0),
           last_accessed_at = $2
       WHERE chat_id = $1`,
      [chatId, currentTime]
    );
    
    // Also notify decay service of memory access (if running)
    if (salienceDecayService) {
      await salienceDecayService.onMemoryAccess(chatId, 'chat');
    }
    
    return true;
  } catch (err) {
    console.error('[Chronicle] Salience boost error:', err);
    return false;
  }
});

ipcMain.handle('load-facts', async (event, chatId) => {
  try {
    const res = await pool.query(
      'SELECT * FROM facts WHERE chat_id = $1 AND valid_to IS NULL ORDER BY salience DESC, created_at DESC',
      [chatId]
    );
    return res.rows.map(r => ({
      id: r.id,
      chatId: r.chat_id,
      subject: r.subject,
      predicate: r.predicate,
      object: r.object,
      confidence: r.confidence,
      salience: r.salience,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      createdAt: Number(r.created_at)
    }));
  } catch (err) {
    console.error('[Chronicle] Load facts error:', err);
    return [];
  }
});

// IPC handler for getting salience decay metrics
ipcMain.handle('get-decay-metrics', async () => {
  if (!salienceDecayService) {
    return { error: 'Decay service not initialized' };
  }
  
  try {
    const metrics = salienceDecayService.getMetrics();
    
    // Also get recent database metrics
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT * FROM salience_decay_metrics 
        ORDER BY run_timestamp DESC 
        LIMIT 10
      `);
      
      return {
        serviceMetrics: metrics,
        recentRuns: result.rows
      };
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[Chronicle] Get decay metrics error:', err);
    return { error: err.message };
  }
});

// IPC handler for manually triggering a decay cycle
ipcMain.handle('trigger-decay-cycle', async () => {
  if (!salienceDecayService) {
    return { error: 'Decay service not initialized' };
  }
  
  try {
    const result = await salienceDecayService.runDecayCycle();
    return { success: true, result };
  } catch (err) {
    console.error('[Chronicle] Manual decay cycle error:', err);
    return { error: err.message };
  }
});

// IPC handler for updating memory type (affects decay rate)
ipcMain.handle('update-memory-type', async (event, chatId, memoryType) => {
  try {
    await pool.query(
      'UPDATE chats SET memory_type = $2 WHERE id = $1',
      [chatId, memoryType]
    );
    return true;
  } catch (err) {
    console.error('[Chronicle] Update memory type error:', err);
    return false;
  }
});

// IPC handler for tracking chat views (rehearsal events that reset decay)
ipcMain.handle('track-chat-view', async (event, chatId) => {
  try {
    const currentTime = Date.now();
    
    // Update last_accessed_at and increment recall_count
    await pool.query(
      `UPDATE chats 
       SET last_accessed_at = $1,
           recall_count = COALESCE(recall_count, 0) + 1
       WHERE id = $2`,
      [currentTime, chatId]
    );
    
    // Also notify decay service
    if (salienceDecayService) {
      await salienceDecayService.onMemoryAccess(chatId, 'chat');
    }
    
    return true;
  } catch (err) {
    console.error('[Chronicle] Track chat view error:', err);
    return false;
  }
});

// Clean up decay service on app quit
app.on('before-quit', () => {
  if (salienceDecayService) {
    console.log('[Chronicle] Stopping salience decay service...');
    salienceDecayService.stop();
  }
});

// Original boilerplate (rest of file) remains unchanged for window creation and other handlers...
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fefef9',
    webPreferences: { 
      preload: path.join(__dirname, 'electron-preload.js'), 
      contextIsolation: true 
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  try {
    await initDatabase();
    
    // Initialize and start salience decay service
    try {
      salienceDecayService = new SalienceDecayService(pool, {
        intervalMs: 900000, // 15 minutes
        batchSize: 100,
        enableLogging: true,
        enableMetrics: true
      });
      
      await salienceDecayService.initializeSchema();
      salienceDecayService.start();
      
      console.log('[Chronicle] Salience decay service initialized and started');
    } catch (decayErr) {
      console.error('[Chronicle] Failed to initialize salience decay service:', decayErr);
      // Don't fail app startup if decay service fails
    }
    
    createWindow();
  } catch (err) {
    console.error('[Chronicle] Application failed to start - database initialization failed:', err);
    dialog.showErrorBox(
      'Database Connection Error',
      `Failed to connect to PostgreSQL database after ${RETRY_CONFIG.maxRetries} attempts.\n\n` +
      `Please ensure:\n` +
      `1. Docker is running with: docker-compose up -d\n` +
      `2. PostgreSQL is accessible at localhost:5432\n\n` +
      `Error: ${err.message}`
    );
    app.quit();
  }
});
