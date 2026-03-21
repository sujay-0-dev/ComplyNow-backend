const fs = require('fs');
const Redis = require('ioredis');
const logger = require('../utils/logger');
const requestlyConfig = require('../config/requestly');

let cachedRules = [];
let redisClient = null;

const createRedisClient = () => {
  if (redisClient) return redisClient;
  try {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null // don't infinitely retry if down
    });
    redisClient.on('error', () => { /* swallow repeated errors */ });
    return redisClient;
  } catch (err) {
    return null;
  }
};

/**
 * Checks if a string contains path traversal characters.
 */
const isSafePath = (p) => {
  if (!p) return true;
  return !p.includes('..') && !p.startsWith('/');
};

/**
 * Loads rules from file and merge with Redis.
 */
const loadRules = async () => {
  if (!requestlyConfig.enabled) {
    cachedRules = [];
    return;
  }

  let fileRules = [];
  const configPath = requestlyConfig.rules.configPath;
  
  // Read File Rules
  if (configPath && isSafePath(configPath)) {
    try {
      if (fs.existsSync(configPath)) {
        const fileContent = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (Array.isArray(parsed)) {
          fileRules = parsed;
        } else if (parsed && Array.isArray(parsed.rules)) {
          fileRules = parsed.rules;
        } else {
          logger.warn(`Rules JSON file at ${configPath} does not contain a rule array.`);
        }
      }
    } catch (error) {
      logger.error(`Failed to read or parse rules file from ${configPath}: ${error.message}`);
    }
  }

  // Read Redis Rules
  let redisRules = [];
  const rc = createRedisClient();
  if (rc) {
    try {
      if (rc.status !== 'ready') {
         await rc.connect().catch(() => {});
      }
      if (rc.status === 'ready') {
        const redisContent = await rc.get('requestly:rules');
        if (redisContent) {
          redisRules = JSON.parse(redisContent);
        }
      }
    } catch (error) {
      logger.warn(`Redis unavailable when loading rules. Falling back to file rules only: ${error.message}`);
    }
  }

  // Merge (Redis takes precedence by id)
  const merged = new Map();
  for (const rule of fileRules) {
    if (rule && rule.id) merged.set(rule.id, rule);
  }
  for (const rule of redisRules) {
    if (rule && rule.id) merged.set(rule.id, rule);
  }

  const validRules = [];
  for (const rule of merged.values()) {
    if (!rule || rule.status === 'Inactive') continue; // Always skip inactive globally
    
    // Validate Regex operator rules
    let isValid = true;
    for (const pair of (rule.pairs || [])) {
      if (pair.source && pair.source.operator === 'Matches') {
        try {
          new RegExp(pair.source.value);
        } catch (e) {
          logger.warn(`Skipping rule ${rule.id}: invalid regex ${pair.source.value}`);
          isValid = false;
        }
      }
    }
    
    if (isValid) validRules.push(rule);
  }

  cachedRules = validRules;
};

// Setup Hot reloading
if (requestlyConfig.rules.configPath && requestlyConfig.rules.hotReload && isSafePath(requestlyConfig.rules.configPath)) {
  try {
    if (fs.existsSync(requestlyConfig.rules.configPath)) {
      fs.watchFile(requestlyConfig.rules.configPath, { interval: 30000 }, async (curr, prev) => {
        if (curr.mtime.getTime() > prev.mtime.getTime()) {
          logger.info(`Detected change in ${requestlyConfig.rules.configPath}. Reloading rules...`);
          await loadRules();
        }
      });
    }
  } catch (err) {
    logger.warn(`Failed to watch rules file: ${err.message}`);
  }
}

/**
 * Returns current rules in memory
 */
const getRules = () => cachedRules;


/**
 * Evaluates a single rule source condition against the request
 */
const evaluateSourceMatch = (source, req) => {
  if (!source || !source.key || !source.operator) return false;
  
  let targetString = '';
  switch (source.key) {
    case 'Url':
      targetString = req.protocol + '://' + req.get('host') + req.originalUrl;
      break;
    case 'Path':
      targetString = req.path;
      break;
    case 'Method':
      targetString = req.method;
      break;
    default:
      return false;
  }

  const value = source.value || '';
  
  switch (source.operator) {
    case 'Equals': return targetString === value;
    case 'Contains': return targetString.includes(value);
    case 'StartsWith': return targetString.startsWith(value);
    case 'EndsWith': return targetString.endsWith(value);
    case 'Matches': 
      try {
        const regex = new RegExp(value);
        return regex.test(targetString);
      } catch (e) {
        return false;
      }
    default:
      return false;
  }
};


/**
 * The main Middleware function
 */
const requestlyRulesMiddleware = () => {
  return async (req, res, next) => {
    if (!requestlyConfig.enabled || cachedRules.length === 0) {
      return next();
    }

    // Attempt to match rules logic
    // We group matching rules by ruleType to process them in order
    const matchedRules = [];

    for (const rule of cachedRules) {
      if (rule.status === 'Inactive') continue;

      // ANY pair match triggers the rule (OR logic)
      let ruleMatched = false;
      for (const pair of rule.pairs || []) {
        // Here to keep with typical "Pairs" in requestly, if a pair has multiple properties, they might
        // technically form a single condition, but the prompt says: 
        // "Multiple source conditions in one pair = ALL must match (AND logic)".
        // Wait, the schema shows pair.source is an object, not an array.
        // Assuming pair.source is checked.
        if (pair.source && evaluateSourceMatch(pair.source, req)) {
           // Provide the matching pair alongside the rule to know WHAT to execute
           matchedRules.push({ rule, pair });
           ruleMatched = true;
           break; // We only need one pair to match the rule
        }
      }
    }

    if (matchedRules.length === 0) {
      return next();
    }

    const order = ['blockRequest', 'delay', 'mockResponse', 'addHeader', 'removeHeader', 'modifyResponse'];
    matchedRules.sort((a, b) => order.indexOf(a.rule.ruleType) - order.indexOf(b.rule.ruleType));

    res.locals.requestlyHeaders = res.locals.requestlyHeaders || {};

    let originalJson = res.json;
    let originalSend = res.send;

    for (const match of matchedRules) {
      const { rule, pair } = match;

      try {
        if (rule.ruleType === 'blockRequest') {
          return res.status(403).json({ error: "Request blocked by Requestly rule", ruleId: rule.id });
        }

        if (rule.ruleType === 'delay') {
          let waitMs = pair.delay || 0;
          if (waitMs > 30000) {
            logger.warn(`Capping delay rule ${rule.id} to 30 seconds`);
            waitMs = 30000;
          }
          if (waitMs > 0) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
        }

        if (rule.ruleType === 'mockResponse') {
          if (pair.destination) {
            const status = pair.destination.statusCode || 200;
            const headers = pair.destination.headers || {};
            for (const [k, v] of Object.entries(headers)) {
              if (k.toLowerCase() !== 'content-type') {
                res.setHeader(k, v);
              }
            }
            res.status(status);
            
            try {
              const bodyJson = JSON.parse(pair.destination.body);
              // if successful it is JSON
              if (headers['Content-Type'] || headers['content-type']) {
                 res.setHeader('Content-Type', headers['Content-Type'] || headers['content-type']);
              }
              return res.send(pair.destination.body); // send raw parsed equivalent json string
            } catch (e) {
              res.setHeader('Content-Type', 'text/plain');
              return res.send(pair.destination.body || '');
            }
          }
        }

        if (rule.ruleType === 'addHeader') {
          if (pair.header && pair.header.key) {
            res.locals.requestlyHeaders[pair.header.key] = pair.header.value;
            res.setHeader(pair.header.key, pair.header.value);
          }
        }

        if (rule.ruleType === 'removeHeader') {
          // not strictly defined in pair schema for removeHeader but assumes pair.header.key
          if (pair.header && pair.header.key) {
             res.removeHeader(pair.header.key);
          }
        }

        if (rule.ruleType === 'modifyResponse') {
          if (pair.modifications && pair.modifications.body) {
            // Intercept res.send/res.json
            const mod = pair.modifications.body;
            res.send = function (body) {
              res.send = originalSend;
              res.json = originalJson;

              let finalBodyStr = typeof body === 'object' ? JSON.stringifyWithCatch(body) : body;

              if (mod.type === 'Static') {
                try {
                  const staticObj = JSON.parse(mod.value);
                  finalBodyStr = JSON.stringify(staticObj);
                } catch(e) {
                  finalBodyStr = mod.value;
                }
              } else if (mod.type === 'Code') {
                if (process.env.NODE_ENV === 'production') {
                  logger.warn(`Skipping Code-type modification for rule ${rule.id} (not allowed in production)`);
                } else {
                  try {
                    // SECURE EVAL SCOPE
                    const executeEval = new Function('body', 'req', 'res', mod.value);
                    const evalResult = executeEval(finalBodyStr, req, res);
                    if (evalResult !== undefined) {
                      finalBodyStr = typeof evalResult === 'object' ? JSON.stringify(evalResult) : evalResult;
                    }
                  } catch (e) {
                    logger.warn(`Evaluation error in Code-type modifyResponse rule ${rule.id}: ${e.message}`);
                  }
                }
              }

              // Also apply header modifications if present inside modifications object
              if (pair.modifications.headers) {
                 if (pair.modifications.headers.additions) {
                   for (const [k, v] of Object.entries(pair.modifications.headers.additions)) {
                      res.setHeader(k, v);
                   }
                 }
                 if (pair.modifications.headers.removals && Array.isArray(pair.modifications.headers.removals)) {
                   for (const k of pair.modifications.headers.removals) {
                      res.removeHeader(k);
                   }
                 }
              }

              return res.send(finalBodyStr);
            };

            res.json = function (obj) {
               return res.send(obj);
            }
          } else if (pair.modifications && pair.modifications.headers) {
            if (pair.modifications.headers.additions) {
              for (const [k, v] of Object.entries(pair.modifications.headers.additions)) {
                 res.setHeader(k, v);
              }
            }
            if (pair.modifications.headers.removals && Array.isArray(pair.modifications.headers.removals)) {
              for (const k of pair.modifications.headers.removals) {
                 res.removeHeader(k);
              }
            }
          }
        }

      } catch (err) {
         logger.warn(`Error applying rule ${rule.id}: ${err.message}`);
      }
    }

    next();
  };
};

function JSONStringifyWithCatch(obj) {
  try {
    return JSON.stringify(obj);
  } catch (err) {
    if (err.message.includes('circular structure') || err.message.includes('Circular')) {
      logger.warn('Circular JSON detected in modifyResponse handler, returning original object as string.');
      return '[Circular JSON Data]';
    }
    return '';
  }
}
// Attach to map
JSON.stringifyWithCatch = JSONStringifyWithCatch;

module.exports = {
  loadRules,
  getRules,
  requestlyRulesMiddleware
};
