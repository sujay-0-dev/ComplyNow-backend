const express = require('express');
const { PerceiverEntry } = require('../models');
const sessionStore = require('../services/sessionStore');
const harAssembler = require('../services/harAssembler');
const forwarder = require('../services/forwarder');
const config = require('../config');

const router = express.Router();

const MASK_PATTERNS = [
  new RegExp(
    '"(password|passwd|pwd|ssn|national_id|credit_card|card_number|cvv|token|api_key|secret|aadhaar|pan_no)"\\s*:\\s*"([^"]{1,200})"',
    'ig'
  )
];

function maskSensitive(text) {
  if (!text) return text;
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    result = result.replace(pattern, '"$1": "****"');
  }
  return result;
}

async function flushSession(sessionId) {
  const session = sessionStore._sessions[sessionId]; // checking exists loosely
  if (!session) return;
  const entries = await sessionStore.flush(sessionId);
  if (entries && entries.length > 0) {
    const har = harAssembler.assemble(entries, session.target_url);
    await forwarder.forwardToBackend(session.audit_id, har, sessionId);
  }
}

router.post('/perceiver', async (req, res) => {
  // Always return 200 fast
  res.status(200).json({ received: true });

  // Do heavy processing asynchronously
  setImmediate(async () => {
    try {
      const entry = PerceiverEntry.parse(req.body);
      entry.response_body = maskSensitive(entry.response_body);
      entry.request_body = maskSensitive(entry.request_body);
      
      const count = await sessionStore.addEntry(entry.session_id, entry);
      if (count === 0) return; // Session not active

      const session = sessionStore._sessions[entry.session_id];
      const now = new Date();
      
      if (count >= config.FLUSH_AFTER_ENTRIES) {
        await flushSession(entry.session_id);
      } else if (session && (now - session.last_flush) >= (config.FLUSH_AFTER_SECONDS * 1000)) {
        await flushSession(entry.session_id);
      }
    } catch (e) {
      console.error("[Perceiver Error]", e.message);
    }
  });
});

module.exports = router;
