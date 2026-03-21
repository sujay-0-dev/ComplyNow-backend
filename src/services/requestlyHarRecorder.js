class CircularBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }

  push(item) {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  toArray() {
    const result = new Array(this.size);
    for (let i = 0; i < this.size; i++) {
      result[i] = this.buffer[(this.head + i) % this.capacity];
    }
    return result;
  }
  
  clear() {
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }
}

class HarRecorder {
  constructor(config, redisClient, logger) {
    this.config = config;
    this.redis = redisClient;
    this.logger = logger;
    this.buffer = new CircularBuffer(config.har.maxEntries || 500);
  }

  async record(entry) {
    if (!entry) {
      this.logger.warn('HarRecorder.record called with null/undefined entry');
      return;
    }

    // 1. In-memory circular buffer
    this.buffer.push(entry);

    // 2. Redis sorted set persistence
    if (this.redis && this.redis.status === 'ready') {
      try {
        const score = new Date(entry.startedDateTime).getTime();
        const payload = JSON.stringify(entry);

        // Fire-and-forget logic using pipelining for efficiency
        this.redis.pipeline()
          .zadd('requestly:har:entries', 'NX', score, payload)
          .zremrangebyrank('requestly:har:entries', 0, -(this.config.har.maxEntries + 1))
          .zremrangebyscore('requestly:har:entries', '-inf', Date.now() - (this.config.har.ttlSeconds * 1000))
          .exec().catch(err => {
             // Silence redis batch errors not throwing into main thread
          });
      } catch (err) {
        // Log locally if immediate validation failure but do not throw
        this.logger.warn(`Failed to start redis batch for HAR record: ${err.message}`);
      }
    }
  }

  async query(filters = {}) {
    let rawEntries = [];
    
    // Fix swapped timestamps
    if (filters.fromMs && filters.toMs && filters.fromMs > filters.toMs) {
      this.logger.warn('HarRecorder.query: fromMs is greater than toMs, swapping them');
      const temp = filters.fromMs;
      filters.fromMs = filters.toMs;
      filters.toMs = temp;
    }

    if (this.redis && this.redis.status === 'ready') {
      try {
        const min = filters.fromMs ? filters.fromMs : '-inf';
        const max = filters.toMs ? filters.toMs : '+inf';
        
        let fetched = await this.redis.zrangebyscore('requestly:har:entries', min, max);
        rawEntries = fetched.map(item => JSON.parse(item));
      } catch (err) {
        this.logger.warn(`HarRecorder.query redis fetch failed, falling back to memory buffer: ${err.message}`);
        rawEntries = this.buffer.toArray();
      }
    } else {
      rawEntries = this.buffer.toArray();
    }

    // Apply client-side filters
    return rawEntries.filter(entry => {
      let match = true;
      const t = new Date(entry.startedDateTime).getTime();
      if (filters.fromMs && t < filters.fromMs) match = false;
      if (filters.toMs && t > filters.toMs) match = false;
      if (filters.method && entry.request.method.toUpperCase() !== filters.method.toUpperCase()) match = false;
      if (filters.urlContains && !entry.request.url.includes(filters.urlContains)) match = false;
      if (filters.statusCode && entry.response.status !== parseInt(filters.statusCode, 10)) match = false;
      if (filters.auditJobId && entry._auditJobId !== filters.auditJobId) match = false;
      return match;
    }).sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));
  }

  async count() {
    let redisCount = null;
    if (this.redis && this.redis.status === 'ready') {
      try {
         redisCount = await this.redis.zcard('requestly:har:entries');
      } catch (e) {}
    }
    return { buffer: this.buffer.size, redis: redisCount };
  }

  async clear() {
    const memoryDeleted = this.buffer.size;
    this.buffer.clear();

    let redisDeleted = 0;
    if (this.redis && this.redis.status === 'ready') {
      try {
         redisDeleted = await this.redis.zcard('requestly:har:entries');
         await this.redis.del('requestly:har:entries');
      } catch (e) {}
    }
    return { deleted: Math.max(memoryDeleted, redisDeleted) };
  }

  redactEntry(entry) {
    if (!entry) return entry;
    // Deep clone basic properties
    const cloned = JSON.parse(JSON.stringify(entry));

    const redactHeadersList = (this.config.har.redactHeaders || []).map(h => h.toLowerCase());
    const redactBodyFieldsList = this.config.har.redactBodyFields || [];
    
    const sensitivePaths = ['/auth', '/login', '/register', '/payment'];

    const redactHeaders = (headersArr) => {
      if (!Array.isArray(headersArr)) return;
      for (const h of headersArr) {
        if (h && h.name && redactHeadersList.includes(h.name.toLowerCase())) {
          h.value = '[REDACTED]';
        }
      }
    };

    const redactBodyText = (text, mimeType, path) => {
      if (!text || typeof text !== 'string') return text;
      
      // File upload bypass
      if (mimeType && mimeType.includes('multipart/form-data')) {
         return '[binary upload: file.ext, Xkb]';
      }

      // Try JSON parsing
      if (mimeType && mimeType.includes('json') || text.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          const scrubJson = (obj) => {
             for (const key in obj) {
               if (redactBodyFieldsList.includes(key)) {
                 obj[key] = '[REDACTED]';
               } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                 scrubJson(obj[key]);
               }
             }
          };
          scrubJson(parsed);
          return JSON.stringify(parsed);
        } catch (e) {
          // Fall through if invalid JSON
        }
      }

      // Non-JSON fallback rule: redact entirely if path is sensitive
      const isSensitivePath = sensitivePaths.some(p => path && path.includes(p));
      if (isSensitivePath) {
        return '[NON-JSON BODY REDACTED]';
      }

      return text;
    };

    if (cloned.request) {
      redactHeaders(cloned.request.headers);
      if (cloned.request.postData && cloned.request.postData.text) {
        cloned.request.postData.text = redactBodyText(
          cloned.request.postData.text,
          cloned.request.postData.mimeType,
          cloned.request.url
        );
      }
    }

    if (cloned.response) {
      redactHeaders(cloned.response.headers);
      if (cloned.response.content && cloned.response.content.text) {
        cloned.response.content.text = redactBodyText(
          cloned.response.content.text,
          cloned.response.content.mimeType,
          cloned.request.url
        );
      }
    }

    return cloned;
  }

  toHarDocument(entries) {
    return {
      log: {
        version: "1.2",
        creator: { name: "ComplyNow", version: "1.0.0" },
        entries: entries || []
      }
    };
  }
}

module.exports = {
  HarRecorder,
  CircularBuffer
};
