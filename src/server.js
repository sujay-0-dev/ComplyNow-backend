const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const logger = require('./utils/logger');
const requestlyConfig = require('./config/requestly');
const { applyRequestlyProxy, removeRequestlyProxy } = require('./middleware/requestlyProxy');
const { requestlyRulesMiddleware, loadRules } = require('./middleware/requestlyRules');

// Import the background Queue and DBs
const { auditQueue } = require('./queue/auditQueue');
const { initPostgres, query } = require('./db/postgres');
const AuditReport = require('./models/AuditReport');

const app = express();
const cors = require('cors');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' })); // Max limit for Har files

// Requestly rules engine (active — may modify/block requests)
app.use(requestlyRulesMiddleware());

// Mount Auth Routes
const authRoutes = require('./routes/auth');
app.use('/api/v1/auth', authRoutes);

// Mount Requestly Admin/Mock Routes
const requestlyRoutes = require('./routes/requestly');
app.use('/requestly', requestlyRoutes);

// Health Check
app.get('/api/v1/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'ComplyNow',
    dependencies: {
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      postgresql: 'disconnected',
      redis: redisClient && redisClient.status === 'ready' ? 'connected' : 'disconnected'
    }
  };

  try {
    await query('SELECT 1');
    health.dependencies.postgresql = 'connected';
  } catch (e) {
    health.dependencies.postgresql = 'error';
  }

  res.json(health);
});

const authenticate = require('./middleware/authenticate');

// 1. Submit Audit (Enqueue Background Job)
app.post('/api/v1/audits', authenticate, async (req, res) => {
  try {
    const { auditMode, targetBaseUrl, privacyPolicyUrl, privacyPolicyText, apiText, dbSchemaText, harTraffic } = req.body;
    
    // Validate that at least one form of input exists
    if (!targetBaseUrl && !privacyPolicyUrl && !privacyPolicyText && !apiText && !dbSchemaText && !harTraffic) {
      return res.status(400).json({ error: 'Payload validation failed: No valid audit inputs provided.' });
    }

    // Generate a job ID explicitly so we can insert it into Postgres first
    const { v4: uuidv4 } = require('uuid');
    const jobId = uuidv4();
    const userId = req.user.id;

    // 💾 Initialize Postgres tracking metadata first
    await query(`INSERT INTO audits (id, user_id, status) VALUES ($1, $2, $3)`, [jobId, userId, 'queued']);

    try {
      // Push the heavy job to Redis/BullMQ with the explicit jobId
      const job = await auditQueue.add('process-audit', {
        auditMode, targetBaseUrl, privacyPolicyUrl, privacyPolicyText, apiText, dbSchemaText, harTraffic
      }, { jobId });

      res.status(202).json({
        message: 'Audit queued successfully',
        auditJobId: job.id,
        status: 'queued'
      });
    } catch (queueErr) {
      // Rollback Postgres if queueing fails
      await query(`DELETE FROM audits WHERE id = $1`, [jobId]);
      throw queueErr;
    }
  } catch (err) {
    logger.error(`Audit queueing failed: ${err.message}`);
    res.status(500).json({ error: 'Queue/DB integration error', details: err.message });
  }
});

// 1.5 Fetch Audit History (Reads from PG)
app.get('/api/v1/audits/history', authenticate, async (req, res) => {
  try {
    const dbRes = await query(
      `SELECT id, status, score, created_at, updated_at FROM audits WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ history: dbRes.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit history', details: err.message });
  }
});

// 2. Poll Status (Reads from PG)
app.get('/api/v1/audits/:id', authenticate, async (req, res) => {
  try {
    const dbRes = await query(`SELECT status, score FROM audits WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (dbRes.rowCount === 0) return res.status(404).json({ error: 'Audit job not found for this user' });
    
    // Fetch live progress from Redis Queue if it's still running
    const job = await auditQueue.getJob(req.params.id);
    const progress = job ? job.progress : 100;
    
    res.json({
      auditJobId: req.params.id,
      status: dbRes.rows[0].status,
      score: dbRes.rows[0].score, // Only populated if finished
      progress
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Fetch Final Report (Reads from MongoDB)
app.get('/api/v1/audits/:id/report', authenticate, async (req, res) => {
  try {
    // Check if PG considers it done AND belongs to user
    const dbRes = await query(`SELECT status FROM audits WHERE id = $1 AND user_id = $2`, [req.params.id, req.user.id]);
    if (dbRes.rowCount === 0) return res.status(404).json({ error: 'Audit job not found for this user' });
    if (dbRes.rows[0].status !== 'completed') {
      return res.status(400).json({ error: `Report not ready. Status: ${dbRes.rows[0].status}` });
    }

    // Fetch the raw massive structural object from Mongo
    const report = await AuditReport.findOne({ jobId: req.params.id }, '-_id -__v');
    if (!report) return res.status(404).json({ error: 'Report data missing from MongoDB. It may have expired.' });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error Handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled Server Error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

let serverInstance = null;
let redisClient = null;

async function bootstrap() {
  try {
    // MongoDB Connection
    const mongoUri = process.env.MONGODB_URI || 'mongodb://root:password@localhost:27017/complynow?authSource=admin';
    await mongoose.connect(mongoUri);
    logger.info('✅ MongoDB connected');

    // Automatically scaffold the PG schema
    await initPostgres();
    
    // Redis Connection for health checks
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    try {
      await redisClient.connect();
      logger.info('✅ Redis connected');
    } catch(err) {
      logger.warn('Redis global connection failed: ' + err.message);
    }
  } catch (dbErr) {
    logger.error(`Database connection failed: ${dbErr.message}. The server will continue gracefully.`);
  }

  // Requestly proxy setup (must be before any outbound requests)
  if (requestlyConfig.proxy.enabled) {
    applyRequestlyProxy();
  }
  
  // Load Requestly rules
  if (requestlyConfig.rules.configPath || requestlyConfig.proxy.enabled) {
    await loadRules();
    logger.info('✅ Requestly rules loaded');
  }

  const PORT = process.env.PORT || 3000;
  serverInstance = app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
  });

  // Graceful shutdown (SIGTERM handler):
  const shutdown = () => {
    logger.info('Shutting down Server...');
    if (requestlyConfig.proxy.enabled) {
      removeRequestlyProxy();
    }
    if (serverInstance) {
      serverInstance.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  bootstrap().catch(err => {
    logger.error(`Bootstrap failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { app, bootstrap };
