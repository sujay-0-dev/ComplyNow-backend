const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      user: process.env.POSTGRES_USER || 'complynow',
      password: process.env.POSTGRES_PASSWORD || 'password',
      host: process.env.POSTGRES_HOST || 'localhost',
      port: process.env.POSTGRES_PORT || 5432,
      database: process.env.POSTGRES_DB || 'complynow',
    });
  }
  return pool;
}

const query = async (text, params) => {
  const start = Date.now();
  const res = await getPool().query(text, params);
  const duration = Date.now() - start;
  logger.debug('Executed DB Query', { text, duration, rows: res.rowCount });
  return res;
};

// Application start wrapper to establish schema
const initPostgres = async () => {
  try {
    const db = getPool();
    await db.query('SELECT 1');
    logger.info('✅ PostgreSQL connected');

    // Create Users Table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add OTP columns to Users Table safely if they don't exist
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;
    `);

    // Create Audit Metadata Table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS audits (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        score INTEGER,
        mongo_report_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // In case audits existed before users, safely add column
    await db.query(`
      ALTER TABLE audits ADD COLUMN IF NOT EXISTS user_id VARCHAR(255);
    `);
    logger.info('✅ PostgreSQL Schema synchronized');
  } catch (err) {
    logger.error('PostgreSQL Initialization failed: ' + err.message);
  }
};

module.exports = {
  getPool,
  query,
  initPostgres
};
