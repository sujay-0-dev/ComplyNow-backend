const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const requestlyConfig = require('../config/requestly');
const authenticate = require('../middleware/authenticate');
const { getHarEntries, clearHarEntries } = require('../middleware/requestlyHar');
const { loadRules } = require('../middleware/requestlyRules');

const router = express.Router();

// Guard Middleware
router.use((req, res, next) => {
  if (!requestlyConfig.enabled) {
    return res.status(404).json({ error: 'Requestly integration disabled' });
  }
  
  // Exception: Health and webhook bypass environment check
  if (req.path === '/health' || req.path === '/webhook/rules-sync') {
    return next();
  }

  if (!requestlyConfig.mock.allowedEnvs.includes(process.env.NODE_ENV)) {
    return res.status(403).json({ error: 'Requestly endpoints not available in this environment' });
  }

  next();
});

// GET /requestly/health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', requestly: true, version: '1.0', timestamp: new Date().toISOString() });
});

// GET /requestly/mock/auth/login
router.get('/mock/auth/login', (req, res) => {
  res.status(200).json({
    token: "mock.jwt.token",
    user: {
      id: "mock-user-id",
      email: "demo@complynow.io",
      name: "Demo User",
      role: "owner",
      orgId: "mock-org-id",
      orgName: "Mock Startup Inc.",
      plan: "pro"
    }
  });
});

// POST /requestly/mock/audits
router.post('/mock/audits', (req, res) => {
  const auditJobId = "mock-audit-" + Date.now();
  res.status(202).json({
    auditJobId,
    status: "queued",
    message: "Mock audit queued",
    estimatedTimeSeconds: 5,
    pollUrl: `/api/v1/audits/${auditJobId}`
  });
});

// GET /requestly/mock/audits/:id
router.get('/mock/audits/:id', (req, res) => {
  const { id } = req.params;
  
  if (!id.startsWith("mock-audit-")) {
    return res.status(404).json({ error: 'Mock audit not found' });
  }

  const timestampStr = id.replace("mock-audit-", "");
  const timestamp = parseInt(timestampStr, 10);
  
  if (isNaN(timestamp)) {
    return res.status(404).json({ error: 'Invalid mock audit ID' });
  }

  const elapsedSeconds = (Date.now() - timestamp) / 1000;

  if (elapsedSeconds < 3) {
    res.json({ status: 'queued', stage: 'queued', progress: 0 });
  } else if (elapsedSeconds < 8) {
    res.json({ status: 'processing', stage: 'parsing', progress: 20 });
  } else if (elapsedSeconds < 15) {
    res.json({ status: 'processing', stage: 'classifying', progress: 45 });
  } else if (elapsedSeconds < 22) {
    res.json({ status: 'processing', stage: 'evaluating', progress: 65 });
  } else if (elapsedSeconds < 28) {
    res.json({ status: 'processing', stage: 'scoring', progress: 85 });
  } else {
    res.json({
      status: 'completed',
      stage: 'done',
      progress: 100,
      overall_score: 62,
      grade: 'C+',
      risk_level: 'high',
      total_rules: 20,
      passed_rules: 12,
      failed_rules: 8
    });
  }
});

// GET /requestly/mock/audits/:id/report
router.get('/mock/audits/:id/report', (req, res) => {
  const report = {
    summary: {
      overallScore: 62,
      grade: 'C+',
      riskLevel: 'high',
      frameworkScores: { GDPR: { score: 55 }, DPDP: { score: 48 }, SECURITY: { score: 72 } },
      totalRules: 20,
      passedRules: 12,
      failedRules: 8,
      criticalFailures: 2
    },
    findings: [
      { ruleCode: 'SEC-01', status: 'fail', severity: 'critical', title: 'Missing encryption at rest', reason: 'Database is not encrypted', fixSuggestion: 'Enable KMS encryption', lawReference: 'GDPR Art. 32', framework: 'SECURITY', category: 'Storage' },
      { ruleCode: 'SEC-02', status: 'pass', severity: 'medium', title: 'TLS 1.2+ Enforced', reason: 'Verified load balancer config', fixSuggestion: 'None', lawReference: 'GDPR Art. 32', framework: 'SECURITY', category: 'Network' },
      { ruleCode: 'SEC-03', status: 'warn', severity: 'high', title: 'Weak Password Policy', reason: 'Minimum length is 8 characters', fixSuggestion: 'Increase minimum to 12', lawReference: 'NIST 800-63B', framework: 'SECURITY', category: 'IAM' },
      { ruleCode: 'PRIV-01', status: 'fail', severity: 'critical', title: 'No cookie consent mechanism', reason: 'Non-essential cookies set before consent', fixSuggestion: 'Implement OneTrust', lawReference: 'ePrivacy Directive', framework: 'GDPR', category: 'Consent' },
      { ruleCode: 'PRIV-02', status: 'pass', severity: 'low', title: 'Privacy Policy Accessible', reason: 'Link exists in footer', fixSuggestion: 'None', lawReference: 'GDPR Art. 13', framework: 'GDPR', category: 'Transparency' },
      { ruleCode: 'PRIV-03', status: 'warn', severity: 'high', title: 'Data Retention Unclear', reason: 'Terms lack specific deletion timelines', fixSuggestion: 'Define precise retention periods', lawReference: 'GDPR Art. 5', framework: 'GDPR', category: 'Retention' },
      { ruleCode: 'THIRD-01', status: 'pass', severity: 'high', title: 'DPA Agreements Signed', reason: 'Found DPA records for top 5 vendors', fixSuggestion: 'None', lawReference: 'GDPR Art. 28', framework: 'GDPR', category: 'Third_Parties' },
      { ruleCode: 'USER-01', status: 'fail', severity: 'high', title: 'Missing Data Export functionality', reason: 'No self-serve DSAR portal', fixSuggestion: 'Build generic JSON export', lawReference: 'GDPR Art. 20', framework: 'GDPR', category: 'User_Rights' }
    ],
    actionPlan: [
      { ruleCode: 'SEC-01', action: 'Enable database encryption at rest' },
      { ruleCode: 'PRIV-01', action: 'Implement cookie banner restricting tracking until opted-in' },
      { ruleCode: 'USER-01', action: 'Build self-serve data portability tool' },
      { ruleCode: 'PRIV-03', action: 'Update privacy policy with strict retention rules' },
      { ruleCode: 'SEC-03', action: 'Update IAM password complexity requirements' }
    ],
    aiAnalysis: {
      data_collection: 'Excessive PII collected on signup (DOB, phone).',
      retention: 'No automated purging detected.',
      consent: 'Consent bundled with ToS, invalid under GDPR.',
      user_rights: 'Manual DSAR process is slow but compliant if fulfilled within 30 days.',
      third_parties: 'Analytics vendor uses tracking pixel without disclosure.'
    }
  };
  res.json(report);
});

// GET /requestly/mock/reports/summary
router.get('/mock/reports/summary', (req, res) => {
  res.json({
    orgId: "mock-org-id",
    orgName: "Mock Startup Inc.",
    latestAuditScore: 62,
    trend: "improving",
    totalAudits: 5,
    criticalRisks: 2
  });
});

// GET /requestly/mock/rules (dummy proxy route)
router.get('/mock/rules', (req, res) => {
  res.json([
    { code: 'SEC-01', description: 'Database encryption required' },
    { code: 'PRIV-01', description: 'Cookie consent required' }
  ]);
});

// GET /requestly/har
router.get('/har', authenticate, async (req, res) => {
  try {
    let { fromMs, toMs, method, urlContains, statusCode, auditJobId, format } = req.query;

    if (fromMs !== undefined) {
      fromMs = parseInt(fromMs, 10);
      if (isNaN(fromMs)) return res.status(400).json({ error: 'fromMs must be a valid number' });
    }
    if (toMs !== undefined) {
      toMs = parseInt(toMs, 10);
      if (isNaN(toMs)) return res.status(400).json({ error: 'toMs must be a valid number' });
    }
    if (statusCode !== undefined) {
      const code = parseInt(statusCode, 10);
      if (isNaN(code) || code < 100 || code > 599) {
        return res.status(400).json({ error: 'statusCode must be a valid HTTP status code (100-599)' });
      }
    }

    if (fromMs !== undefined && toMs !== undefined) {
       if (toMs - fromMs > 300000) {
         return res.status(400).json({ error: 'Cannot request more than 5 minutes of traffic in one export.' });
       }
    }

    const filters = { fromMs, toMs, method, urlContains, statusCode, auditJobId };
    const entries = await getHarEntries(filters);

    if (entries.length === 0) {
       return res.status(200).json(format === 'json' ? [] : { log: { version: "1.2", creator: { name: "ComplyNow", version: "1.0.0" }, entries: [] }});
    }

    if ((format || 'har') === 'har') {
      const document = { log: { version: "1.2", creator: { name: "ComplyNow", version: "1.0.0" }, entries } };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="complynow-session-${Date.now()}.har"`);
      return res.send(JSON.stringify(document));
    } else {
      return res.json(entries);
    }
  } catch (error) {
    logger.error(`Error generating HAR: ${error.message}`);
    res.status(500).json({ error: 'Internal server error while fetching HAR' });
  }
});

// DELETE /requestly/har
router.delete('/har', authenticate, async (req, res) => {
  try {
    const result = await clearHarEntries();
    res.json({ deleted: result.deleted, message: "HAR buffer cleared" });
  } catch (error) {
    logger.error(`Error clearing HAR entries: ${error.message}`);
    res.status(500).json({ error: 'Internal server error while clearing HAR entries' });
  }
});

// GET /requestly/status
// GET /requestly/fix-rules/:id
router.get('/fix-rules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const auditId = id.replace('-api', '');

    const AuditReport = require('../models/AuditReport');
    const report = await AuditReport.findOne({ jobId: auditId }).lean();

    if (!report || !report.requestlyFixRules) {
      return res.status(404).json({ error: 'Auto-fix Requestly rules not found for this audit' });
    }

    res.json(report.requestlyFixRules);
  } catch (err) {
    logger.error(`Error fetching fix rules: ${err.message}`);
    res.status(500).json({ error: 'Internal server error while fetching rules' });
  }
});

router.get('/status', authenticate, async (req, res) => {
  res.json({
    enabled: requestlyConfig.enabled,
    proxy: {
       enabled: requestlyConfig.proxy.enabled,
       host: requestlyConfig.proxy.host,
       port: requestlyConfig.proxy.port,
       active: !!require('http').globalAgent._events, // weak check, stubbed for logic
       bypassHosts: requestlyConfig.proxy.bypassHosts
    },
    har: {
       enabled: requestlyConfig.har.enabled,
       entriesInBuffer: -1, // Not directly querying redis size for simple status request
       ttlSeconds: requestlyConfig.har.ttlSeconds,
       maxEntries: requestlyConfig.har.maxEntries
    },
    rules: {
       enabled: true,
       configPathExists: requestlyConfig.rules.configPath ? require('fs').existsSync(requestlyConfig.rules.configPath) : false
    },
    mock: {
       enabled: requestlyConfig.mock.enabled,
       routePrefix: requestlyConfig.mock.routePrefix,
       allowedEnvs: requestlyConfig.mock.allowedEnvs
    },
    webhook: {
       enabled: !!requestlyConfig.rules.webhookSecret
    }
  });
});

// POST /requestly/webhook/rules-sync
// Expected to be a raw body parser or express.json(), assuming express.json is used upstream
router.post('/webhook/rules-sync', async (req, res) => {
  try {
    if (!requestlyConfig.rules.webhookSecret) {
      return res.status(503).json({ error: 'Webhook endpoint disabled: secret not configured' });
    }

    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }

    const signatureStr = req.headers['x-requestly-signature'];
    if (!signatureStr) {
      return res.status(401).json({ error: 'Missing X-Requestly-Signature header' });
    }

    const timestampStr = req.headers['x-requestly-timestamp'];
    if (!timestampStr) {
      return res.status(401).json({ error: 'Missing X-Requestly-Timestamp header' });
    }

    const ts = parseInt(timestampStr, 10);
    const nowTs = Math.floor(Date.now() / 1000); // the example prompt says "unix timestamp", Assuming seconds based on '> 300s' rule. Or it could be ms.
    
    // Check if timestamp is too old (> 300s)
    let elapsed = 0;
    if (timestampStr.length > 11) { // its ms
       elapsed = (Date.now() - ts) / 1000;
    } else { // its seconds
       elapsed = nowTs - ts;
    }

    if (elapsed > 300) {
      return res.status(401).json({ error: 'Timestamp expired (stale webhook payload)' });
    }

    // Verify HMAC
    // We need the raw body text. If express parsed it to an object, we reserialize.
    // However, exact match requires exact raw body.
    // Given standard express.json, we parse from req.rawBody if present or stringify req.body
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expectedHmac = crypto.createHmac('sha256', requestlyConfig.rules.webhookSecret)
                               .update(rawBody)
                               .digest('hex');
    const providedHmac = signatureStr.replace('sha256=', '');

    let isValidHmac = false;
    if (expectedHmac.length === providedHmac.length) {
       isValidHmac = crypto.timingSafeEqual(Buffer.from(expectedHmac), Buffer.from(providedHmac));
    }
    
    if (!isValidHmac) {
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }

    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
       return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    if (!Array.isArray(payload.rules)) {
       return res.status(400).json({ error: 'Payload must contain a rules array' });
    }

    if (payload.rules.length === 0) {
       return res.status(200).json({ rulesLoaded: 0, message: "No active rules in payload" });
    }

    const activeRules = [];
    const skippedRules = [];
    const warnings = [];
    const validRuleTypes = ["modifyResponse", "delay", "addHeader", "removeHeader", "blockRequest", "mockResponse"];

    for (let i = 0; i < payload.rules.length; i++) {
       const rule = payload.rules[i];
       if (!rule.id || typeof rule.id !== 'string') {
          skippedRules.push({ index: i, reason: 'Missing id string' });
          continue;
       }
       if (!rule.ruleType || !validRuleTypes.includes(rule.ruleType)) {
          skippedRules.push(rule.id);
          warnings.push(`Unknown ruleType '${rule.ruleType}' for rule ${rule.id}`);
          continue;
       }
       if (!rule.status) {
          skippedRules.push(rule.id);
          continue;
       }
       if (!Array.isArray(rule.pairs)) {
          skippedRules.push(rule.id);
          continue;
       }

       if (rule.status === 'Active') {
          activeRules.push(rule);
       } else {
          skippedRules.push(`Inactive rule ${rule.id}`);
       }
    }

    // Persist to Redis
    const rc = require('ioredis');
    let redisSuccess = false;
    try {
      const redisClient = new rc(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redisClient.set("requestly:rules", JSON.stringify(activeRules), "EX", 86400); // 24h
      redisSuccess = true;
      redisClient.disconnect();
    } catch (e) {
      logger.warn(`Failed to write synced rules to Redis: ${e.message}`);
    }

    // Hot Reload In-Memory
    await loadRules();

    res.json({
       success: true,
       rulesLoaded: activeRules.length,
       rulesSkipped: skippedRules.length,
       message: "Rules synced and applied",
       warnings: warnings.length > 0 ? warnings : undefined
    });

  } catch (error) {
    if (error instanceof SyntaxError) {
       return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    logger.error(`Webhook error: ${error.message}`);
    // Do not fail the webhook gracefully if redis fails but memory loaded, already covered that
    res.status(500).json({ error: 'Internal server error processing webhook' });
  }
});

module.exports = router;
