const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');
const logger = require('../utils/logger');
const requestlyConfig = require('../config/requestly');
const { HarRecorder } = require('../services/requestlyHarRecorder');

let redisClient = null;
let harRecorderInstance = null;

const createRedisClient = () => {
  if (redisClient) return redisClient;
  try {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    redisClient.on('error', () => {});
    return redisClient;
  } catch (err) {
    return null;
  }
};

const getRecorder = () => {
  if (!harRecorderInstance && requestlyConfig.har.enabled) {
    harRecorderInstance = new HarRecorder(requestlyConfig, createRedisClient(), logger);
  }
  return harRecorderInstance;
};

// Transform internal Node objects to HAR format
const toHarHeaders = (headersObj) => {
  if (!headersObj) return [];
  return Object.keys(headersObj).map(name => {
     let value = headersObj[name];
     if (Array.isArray(value)) value = value.join(', ');
     if (value === undefined) value = '';
     return { name, value: String(value) };
  });
};

const toHarQuery = (queryObj) => {
  if (!queryObj) return [];
  return Object.keys(queryObj).map(name => {
     let value = queryObj[name];
     if (Array.isArray(value)) value = value.join(', ');
     if (value === undefined) value = '';
     return { name, value: String(value) };
  });
};


const requestlyHarMiddleware = () => {
  return (req, res, next) => {
    if (!requestlyConfig.har.enabled) return next();

    // Never record health check or webhooks
    if (req.path === '/api/v1/health' || req.path === '/health' || req.path === '/requestly/health' || req.path === '/requestly/webhook/rules-sync') {
      return next();
    }

    const _requestId = uuidv4();
    req._requestlyStart = Date.now();
    
    // Capture Request Body Stream (for express parsers)
    let reqBodyText = '';
    const originReqWrite = req.write;
    const originReqEnd = req.end;

    // Buffer original request body if not parsed by body-parser
    // Usually express has body-parser so req.body is an object.
    
    const originalEnd = res.end;
    const originalWrite = res.write;
    
    const chunks = [];
    
    res.write = function (chunk, ...args) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return originalWrite.apply(res, [chunk, ...args]);
    };

    res.end = function(chunk, encoding, cb) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      
      const resBodyBuffer = Buffer.concat(chunks);
      const resBodyText = resBodyBuffer.toString('utf8');

      const endTime = Date.now();
      const waitTime = endTime - req._requestlyStart;

      // Ensure req.body is serialized
      if (!reqBodyText && req.body && Object.keys(req.body).length > 0) {
        reqBodyText = (typeof req.body === 'object') ? JSON.stringify(req.body) : req.body;
      }

      const reqHeaders = toHarHeaders(req.headers);
      const reqQuery = toHarQuery(req.query);
      const reqMimeType = req.headers['content-type'] || '';
      
      let postData;
      if (req.method !== 'GET' && req.method !== 'OPTIONS') {
        postData = {
          mimeType: reqMimeType,
          text: reqBodyText
        };
      }

      const resHeaders = toHarHeaders(res.getHeaders());
      const resMimeType = res.getHeader('content-type') || '';
      
      let auditJobId = (req.body && req.body.auditJobId) || res.locals?.auditJobId;

      const entry = {
        startedDateTime: new Date(req._requestlyStart).toISOString(),
        time: waitTime,
        request: {
          method: req.method,
          url: req.protocol + '://' + req.get('host') + req.originalUrl,
          httpVersion: "HTTP/1.1",
          headers: reqHeaders,
          queryString: reqQuery,
          postData,
          headersSize: -1,
          bodySize: reqBodyText ? reqBodyText.length : 0
        },
        response: {
          status: res.statusCode,
          statusText: res.statusMessage || String(res.statusCode),
          headers: resHeaders,
          content: {
            size: resBodyText.length,
            mimeType: String(resMimeType),
            text: resBodyText
          },
          headersSize: -1,
          bodySize: resBodyText.length,
          redirectURL: ""
        },
        timings: { send: 0, wait: waitTime, receive: 0 },
        _requestId,
        _auditJobId: auditJobId
      };

      const recorder = getRecorder();
      if (recorder) {
        const redactedEntry = recorder.redactEntry(entry);
        recorder.record(redactedEntry); // fire and forget
      }

      originalEnd.apply(res, [chunk, encoding, cb]);
    };

    next();
  };
};


const getHarEntries = async (filters) => {
  const recorder = getRecorder();
  if (!recorder) return [];
  return await recorder.query(filters);
};

const clearHarEntries = async () => {
  const recorder = getRecorder();
  if (!recorder) return { deleted: 0 };
  return await recorder.clear();
};

module.exports = {
  requestlyHarMiddleware,
  getHarEntries,
  clearHarEntries
};
