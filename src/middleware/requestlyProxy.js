const fs = require('fs');
const http = require('http');
const https = require('https');
const logger = require('../utils/logger');
const requestlyConfig = require('../config/requestly');

let originalHttpAgent = null;
let originalHttpsAgent = null;

/**
 * Checks if a hostname matches any bypass rules.
 * @param {string} hostname 
 * @param {string[]} bypassList 
 * @returns {boolean}
 */
const shouldBypass = (hostname, bypassList) => {
  if (!hostname) return false;
  
  // Normalize localhost variants
  const normalizedHost = (hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') ? 'localhost' : hostname;

  for (const bypassHost of bypassList) {
    if (bypassHost.startsWith('*.')) {
      const suffix = bypassHost.slice(1); // e.g. .internal.com
      if (normalizedHost.endsWith(suffix) || normalizedHost === bypassHost.slice(2)) {
        return true;
      }
    } else if (normalizedHost === bypassHost) {
      return true;
    }
  }
  return false;
};

/**
 * Applies the proxy to global HTTP and HTTPS agents.
 * Must be called once at startup.
 */
function applyRequestlyProxy() {
  if (!requestlyConfig.proxy.enabled) return;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Requestly proxy cannot be enabled in a production environment.');
  }

  let HttpProxyAgent, HttpsProxyAgent;
  try {
    HttpProxyAgent = require('http-proxy-agent').HttpProxyAgent;
    HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
  } catch (error) {
    logger.error('Install https-proxy-agent & http-proxy-agent: npm i https-proxy-agent http-proxy-agent');
    return;
  }

  const bypassList = requestlyConfig.proxy.bypassHosts;
  
  // Check proxy connectivity
  const proxyUrl = `http://${requestlyConfig.proxy.host}:${requestlyConfig.proxy.port}`;
  const pingReq = http.request({
    method: 'OPTIONS',
    hostname: requestlyConfig.proxy.host,
    port: requestlyConfig.proxy.port,
    path: '/',
    timeout: 2000
  });

  pingReq.on('error', (err) => {
    logger.warn(`Requestly proxy unreachable at ${proxyUrl} during startup: ${err.message}. It will still be configured, but requests might fail if it doesn't come up.`);
  });
  pingReq.on('timeout', () => {
    logger.warn(`Requestly proxy connection timed out during startup at ${proxyUrl}`);
    pingReq.destroy();
  });
  pingReq.end();

  originalHttpAgent = http.globalAgent;
  originalHttpsAgent = https.globalAgent;

  // Custom HTTP Agent
  class CustomHttpAgent extends http.Agent {
    constructor(opts) {
      super(opts);
      this.proxyAgent = new HttpProxyAgent(proxyUrl);
    }
    
    addRequest(req, options) {
      if (shouldBypass(options.host || options.hostname, bypassList)) {
        super.addRequest(req, options);
      } else {
        this.proxyAgent.addRequest(req, options);
      }
    }
  }

  // Custom HTTPS Agent
  const proxyOptions = {};
  if (requestlyConfig.proxy.sslBump) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    logger.warn('⚠️  SSL verification disabled for Requestly proxy — development only');
  } else if (process.env.REQUESTLY_CA_CERT_PATH) {
    try {
      proxyOptions.ca = [fs.readFileSync(process.env.REQUESTLY_CA_CERT_PATH)];
    } catch (error) {
      logger.error(`Failed to load Requestly CA cert from ${process.env.REQUESTLY_CA_CERT_PATH}: ${error.message}`);
    }
  }

  class CustomHttpsAgent extends https.Agent {
    constructor(opts) {
      super(opts);
      this.proxyAgent = new HttpsProxyAgent(proxyUrl, proxyOptions);
    }
    
    addRequest(req, options) {
      if (shouldBypass(options.host || options.hostname, bypassList)) {
        super.addRequest(req, options);
      } else {
        this.proxyAgent.addRequest(req, options);
      }
    }
  }

  http.globalAgent = new CustomHttpAgent({ keepAlive: true });
  https.globalAgent = new CustomHttpsAgent({ keepAlive: true });

  logger.info(`Requestly proxy configured to intercept traffic through ${proxyUrl} (Bypassing: ${bypassList.join(', ') || 'none'})`);
}

/**
 * Restores original global agents.
 */
function removeRequestlyProxy() {
  if (originalHttpAgent) http.globalAgent = originalHttpAgent;
  if (originalHttpsAgent) https.globalAgent = originalHttpsAgent;
  logger.info('Requestly proxy removed');
}

module.exports = {
  applyRequestlyProxy,
  removeRequestlyProxy
};
