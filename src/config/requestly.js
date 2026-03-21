const logger = require('../utils/logger');

/**
 * Splits a comma-separated string into a trimmed array.
 * @param {string} str 
 * @returns {string[]}
 */
const parseArray = (str) => {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(s => s.length > 0);
};

const proxyPort = parseInt(process.env.REQUESTLY_PROXY_PORT, 10);
const finalProxyPort = (!isNaN(proxyPort) && proxyPort > 0) ? proxyPort : 8888;
if (process.env.REQUESTLY_PROXY_PORT && (isNaN(proxyPort) || proxyPort <= 0)) {
  logger.warn(`Invalid REQUESTLY_PROXY_PORT provided. Defaulting to ${finalProxyPort}`);
}

const mockEnvs = parseArray(process.env.REQUESTLY_MOCK_ENVS).filter(env => env !== 'production');
if (parseArray(process.env.REQUESTLY_MOCK_ENVS).includes('production')) {
  logger.warn(`'production' environment removed from REQUESTLY_MOCK_ENVS. Mocking is never allowed in production.`);
}

let harMaxEntries = parseInt(process.env.REQUESTLY_HAR_MAX_ENTRIES, 10) || 500;
if (harMaxEntries > 10000) {
  logger.warn(`REQUESTLY_HAR_MAX_ENTRIES > 10000. Capping at 10000.`);
  harMaxEntries = 10000;
}

const webhookSecret = process.env.REQUESTLY_WEBHOOK_SECRET || '';
if (webhookSecret && webhookSecret.length < 16) {
  logger.error(`REQUESTLY_WEBHOOK_SECRET is shorter than 16 characters. Webhook endpoint will be disabled.`);
}

const config = {
  enabled: process.env.REQUESTLY_ENABLED === 'true',
  proxy: {
    enabled: process.env.REQUESTLY_PROXY_ENABLED === 'true',
    host: process.env.REQUESTLY_PROXY_HOST || 'localhost',
    port: finalProxyPort,
    bypassHosts: parseArray(process.env.REQUESTLY_PROXY_BYPASS),
    sslBump: process.env.REQUESTLY_PROXY_SSL === 'true',
  },
  mock: {
    enabled: process.env.REQUESTLY_MOCK_ENABLED === 'true',
    routePrefix: process.env.REQUESTLY_MOCK_PREFIX || '/requestly',
    allowedEnvs: mockEnvs,
  },
  har: {
    enabled: process.env.REQUESTLY_HAR_ENABLED === 'true',
    maxEntries: harMaxEntries,
    ttlSeconds: parseInt(process.env.REQUESTLY_HAR_TTL, 10) || 3600,
    redactHeaders: parseArray(process.env.REQUESTLY_HAR_REDACT_HEADERS),
    redactBodyFields: parseArray(process.env.REQUESTLY_HAR_REDACT_FIELDS),
  },
  rules: {
    configPath: process.env.REQUESTLY_RULES_PATH || './requestly-rules.json',
    hotReload: process.env.REQUESTLY_RULES_HOT_RELOAD === 'true',
    webhookSecret: webhookSecret.length >= 16 ? webhookSecret : null,
  }
};

module.exports = Object.freeze(config);
