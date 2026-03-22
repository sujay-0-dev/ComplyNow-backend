const axios = require('axios');
const config = require('../config');

async function forwardToBackend(auditId, har, sessionId) {
  const payload = {
    audit_id: auditId,
    audit_mode: "traffic",
    source: "requestly_capture",
    session_id: sessionId,
    live_data: {
      har_traffic: har
    }
  };

  try {
    const response = await axios.post(
      `${config.BACKEND_URL}${config.BACKEND_AUDIT_ENDPOINT}`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Service-Key": config.BACKEND_API_KEY
        },
        timeout: 10000
      }
    );
    return response.status === 200 || response.status === 202;
  } catch (err) {
    console.error(`Failed to forward HAR to backend: ${err.message}`);
    return false;
  }
}

module.exports = { forwardToBackend };
