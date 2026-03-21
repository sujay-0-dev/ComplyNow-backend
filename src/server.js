require("dotenv").config();
const express = require('express');
const mongoose = require('mongoose');
const pgPool = require('./config/db');
const Redis = require('ioredis');
const logger = require('./utils/logger');
const { submitAuditToWorker } = require('./services/workerIntegration');
const requestlyConfig = require('./config/requestly');
const { applyRequestlyProxy, removeRequestlyProxy } = require('./middleware/requestlyProxy');
const { requestlyHarMiddleware } = require('./middleware/requestlyHar');
const { requestlyRulesMiddleware, loadRules } = require('./middleware/requestlyRules');
const requestlyRoutes = require('./routes/requestly');

const app = express();

// Basic middleware needed for the application
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware registration (order matters — add AFTER security middleware, BEFORE routes):
// Requestly HAR recorder (passive — just records)
if (requestlyConfig.har.enabled) {
  app.use(requestlyHarMiddleware());
}

// Requestly rules engine (active — may modify/block requests)
app.use(requestlyRulesMiddleware());

// Existing ComplyNow Routes
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

  if (pgPool) {
    try {
      await pgPool.query('SELECT 1');
      health.dependencies.postgresql = 'connected';
    } catch (e) {
      health.dependencies.postgresql = 'error';
    }
  }

  res.json(health);
});

app.post('/api/v1/audits', async (req, res) => {
  try {
    const { auditMode, targetBaseUrl, privacyPolicyUrl, privacyPolicyText, apiText, dbSchemaText, harTraffic } = req.body;
    
    // Fast path bypass to dummy response if worker is disabled
    if (!process.env.WORKER_URL) {
      return res.json({ message: 'Audit triggered (Mocked - configure WORKER_URL)', auditJobId: req.body.auditJobId || 'real-audit-1' });
    }

    const workerResult = await submitAuditToWorker({
      auditMode,
      targetBaseUrl,
      privacyPolicyUrl,
      privacyPolicyText,
      apiText,
      dbSchemaText,
      harTraffic
    });

    res.json({
      message: 'Audit completed successfully',
      requestId: workerResult.requestId,
      workerResponse: workerResult.result,
      requestlyMockData: workerResult.requestlyImportPayload
    });
  } catch (err) {
    logger.error(`Audit worker failed: ${err.message}`);
    // Return graceful 500
    res.status(500).json({ error: 'Worker integration error', details: err.message });
  }
});

app.get('/api/v1/audits/:id/report', (req, res) => {
  res.json({ report: `Report for audit ${req.params.id}`, summary: { overallScore: 80 } });
});

// Requestly Route registration (add with other API routes):
app.use(requestlyConfig.mock.routePrefix, requestlyRoutes);

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

    // PostgreSQL Connection
    await pgPool.query('SELECT 1');
    logger.info('✅ PostgreSQL connected');
    
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
    logger.error(`Database connection failed: ${dbErr.message}. The server will continue without DBs for mock endpoints.`);
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

module.exports = { app, bootstrap};
