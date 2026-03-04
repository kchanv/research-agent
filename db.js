const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

pool.on('error', (err) => console.error('DB pool error:', err.message));

// ─── Create agent tables if they don't exist ─────────────────────────────────

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id SERIAL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(agent_name, key)
      );

      CREATE TABLE IF NOT EXISTS agent_conversations (
        id SERIAL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id SERIAL PRIMARY KEY,
        agent_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS agent_feedback (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES agent_events(id),
        outcome TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB tables ready.');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// ─── Memory (persistent key-value per agent) ─────────────────────────────────

async function getMemory(agentName, key) {
  try {
    const res = await pool.query(
      'SELECT value FROM agent_memory WHERE agent_name = $1 AND key = $2',
      [agentName, key]
    );
    return res.rows[0]?.value || null;
  } catch (e) {
    console.error('getMemory error:', e.message);
    return null;
  }
}

async function setMemory(agentName, key, value) {
  try {
    await pool.query(
      `INSERT INTO agent_memory (agent_name, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (agent_name, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [agentName, key, value]
    );
  } catch (e) {
    console.error('setMemory error:', e.message);
  }
}

async function getAllMemory(agentName) {
  try {
    const res = await pool.query(
      'SELECT key, value FROM agent_memory WHERE agent_name = $1 ORDER BY updated_at ASC',
      [agentName]
    );
    return res.rows;
  } catch (e) {
    console.error('getAllMemory error:', e.message);
    return [];
  }
}

// ─── Conversation history ─────────────────────────────────────────────────────

async function getConversationHistory(agentName, chatId, limit = 30) {
  try {
    const res = await pool.query(
      `SELECT role, content FROM agent_conversations
       WHERE agent_name = $1 AND chat_id = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      [agentName, chatId.toString(), limit]
    );
    return res.rows;
  } catch (e) {
    console.error('getConversationHistory error:', e.message);
    return [];
  }
}

async function saveMessage(agentName, chatId, role, content) {
  try {
    await pool.query(
      'INSERT INTO agent_conversations (agent_name, chat_id, role, content) VALUES ($1, $2, $3, $4)',
      [agentName, chatId.toString(), role, content]
    );
    // Keep only last 50 messages per chat to avoid bloat
    await pool.query(
      `DELETE FROM agent_conversations
       WHERE agent_name = $1 AND chat_id = $2
       AND id NOT IN (
         SELECT id FROM agent_conversations
         WHERE agent_name = $1 AND chat_id = $2
         ORDER BY created_at DESC LIMIT 50
       )`,
      [agentName, chatId.toString()]
    );
  } catch (e) {
    console.error('saveMessage error:', e.message);
  }
}

// ─── Events (agent activity log) ─────────────────────────────────────────────

async function logEvent(agentName, eventType, data = {}) {
  try {
    const res = await pool.query(
      'INSERT INTO agent_events (agent_name, event_type, data) VALUES ($1, $2, $3) RETURNING id',
      [agentName, eventType, JSON.stringify(data)]
    );
    return res.rows[0]?.id;
  } catch (e) {
    console.error('logEvent error:', e.message);
    return null;
  }
}

async function logFeedback(eventId, outcome, notes = '') {
  try {
    await pool.query(
      'INSERT INTO agent_feedback (event_id, outcome, notes) VALUES ($1, $2, $3)',
      [eventId, outcome, notes]
    );
  } catch (e) {
    console.error('logFeedback error:', e.message);
  }
}

module.exports = { initDB, getMemory, setMemory, getAllMemory, getConversationHistory, saveMessage, logEvent, logFeedback };
