const express = require('express');
const path = require('path');
const fs = require('fs');
const { SessionCreateRequest, FixRulesRequest } = require('../models');
const sessionStore = require('../services/sessionStore');
const captureRule = require('../services/captureRule');
const fixRule = require('../services/fixRule');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');
const harAssembler = require('../services/harAssembler');
const forwarder = require('../services/forwarder');

const router = express.Router();

function ensureRulesDir() {
  const dir = path.join(process.cwd(), config.RULES_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ENDPOINT 1 (Usually hit on /session/create)
router.post('/session/create', async (req, res) => {
  try {
    const data = SessionCreateRequest.parse(req.body);
    const sessionId = `sess_${uuidv4().replace(/-/g, '')}`;

    await sessionStore.create(sessionId, data.audit_id, data.target_url || "");

    const ruleData = captureRule.build(sessionId, config.PUBLIC_BASE_URL);
    
    const rulesDir = ensureRulesDir();
    const filePath = path.join(rulesDir, `capture-${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(ruleData, null, 2));

    const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);

    res.json({
      session_id: sessionId,
      capture_rule_url: `${config.PUBLIC_BASE_URL}/requestly/capture-rule/${sessionId}`,
      expires_at: expiresAt.toISOString()
    });
  } catch (err) {
    res.status(400).json({ error: err.issues || err.message });
  }
});

// ENDPOINT 2
router.get('/capture-rule/:session_id', (req, res) => {
  const { session_id } = req.params;
  const filePath = path.join(process.cwd(), config.RULES_DIR, `capture-${session_id}.json`);
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: "Session capture rule not found or expired" });
  }
});

// ENDPOINT 5
router.post('/fix-rules', async (req, res) => {
  try {
    const data = FixRulesRequest.parse(req.body);
    
    const ruleData = fixRule.build(data.audit_id, data.fix_simulations);
    
    const rulesDir = ensureRulesDir();
    const filePath = path.join(rulesDir, `fixes-${data.audit_id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(ruleData, null, 2));

    const expiresAt = new Date(Date.now() + config.RULE_TTL_HOURS * 3600 * 1000);

    res.json({
      audit_id: data.audit_id,
      fix_rule_url: `${config.PUBLIC_BASE_URL}/requestly/fix-rules/${data.audit_id}`,
      rule_count: ruleData.rules.length,
      expires_at: expiresAt.toISOString()
    });
  } catch (err) {
    res.status(400).json({ error: err.issues || err.message });
  }
});

// ENDPOINT 6
router.get('/fix-rules/:audit_id', (req, res) => {
  const { audit_id } = req.params;
  const filePath = path.join(process.cwd(), config.RULES_DIR, `fixes-${audit_id}.json`);
  
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: "Fix rules not found" });
  }
});

// ENDPOINT 4 (Usually hit as /session/:session_id/end)
router.post('/session/:session_id/end', async (req, res) => {
  const { session_id } = req.params;
  
  const entries = await sessionStore.flush(session_id);
  const session = await sessionStore.end(session_id);
  
  if (!session || !session.audit_id) {
    return res.status(404).json({ error: "Session not found" });
  }

  const har = harAssembler.assemble(entries, session.target_url);
  await forwarder.forwardToBackend(session.audit_id, har, session_id);

  res.json({
    session_id,
    entries_flushed: entries.length,
    forwarded_to: "backend",
    audit_queued: true
  });
});

module.exports = router;
