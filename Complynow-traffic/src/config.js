const dotenv = require('dotenv');
dotenv.config();

module.exports = {
  TRAFFIC_PORT: parseInt(process.env.TRAFFIC_PORT || '8001', 10),
  TRAFFIC_HOST: process.env.TRAFFIC_HOST || '0.0.0.0',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || 'http://localhost:8001',

  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:3000',
  BACKEND_AUDIT_ENDPOINT: process.env.BACKEND_AUDIT_ENDPOINT || '/api/v1/audits/from-traffic',
  BACKEND_API_KEY: process.env.BACKEND_API_KEY || 'internal_service_key_here',

  SESSION_TTL_SECONDS: parseInt(process.env.SESSION_TTL_SECONDS || '300', 10),
  MAX_ENTRIES_PER_SESSION: parseInt(process.env.MAX_ENTRIES_PER_SESSION || '500', 10),
  FLUSH_AFTER_ENTRIES: parseInt(process.env.FLUSH_AFTER_ENTRIES || '50', 10),
  FLUSH_AFTER_SECONDS: parseInt(process.env.FLUSH_AFTER_SECONDS || '30', 10),

  RULES_DIR: process.env.RULES_DIR || 'public/rules',
  RULE_TTL_HOURS: parseInt(process.env.RULE_TTL_HOURS || '24', 10)
};
