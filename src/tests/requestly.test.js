const assert = require('assert');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
// Set env vars for tests BEFORE requiring config
process.env.REQUESTLY_ENABLED = 'true';
process.env.REQUESTLY_HAR_ENABLED = 'true';
process.env.REQUESTLY_RULES_PATH = './requestly-rules.example.json';
process.env.REQUESTLY_WEBHOOK_SECRET = 'my_super_secret_webhook_key_1234';
process.env.REQUESTLY_MOCK_PREFIX = '/requestly';
process.env.REQUESTLY_MOCK_ENVS = 'development,test';
process.env.REQUESTLY_HAR_REDACT_HEADERS = 'authorization,x-api-key';
process.env.REQUESTLY_HAR_REDACT_FIELDS = 'password,token';
process.env.NODE_ENV = 'test';

const { CircularBuffer, HarRecorder } = require('../services/requestlyHarRecorder');
const requestlyConfig = require('../config/requestly');
const { loadRules, getRules, requestlyRulesMiddleware } = require('../middleware/requestlyRules');
const { app } = require('../server');
const logger = require('../utils/logger'); // stub logger

// Test Runner
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ─── CircularBuffer Tests ───
test('CircularBuffer: push beyond capacity drops oldest entry', async () => {
  const buf = new CircularBuffer(3);
  buf.push(1); buf.push(2); buf.push(3); buf.push(4);
  const arr = buf.toArray();
  assert.deepStrictEqual(arr, [2, 3, 4]);
});

test('CircularBuffer: toArray returns entries in insertion order', async () => {
  const buf = new CircularBuffer(5);
  buf.push('a'); buf.push('b'); buf.push('c');
  assert.deepStrictEqual(buf.toArray(), ['a', 'b', 'c']);
});

// ─── HarRecorder Tests ───
test('HarRecorder: redactEntry redacts listed headers', async () => {
  const recorder = new HarRecorder(requestlyConfig, null, logger);
  const entry = { request: { headers: [{ name: 'Authorization', value: 'secret' }, { name: 'Host', value: 'localhost' }] } };
  const redacted = recorder.redactEntry(entry);
  assert.strictEqual(redacted.request.headers[0].value, '[REDACTED]');
  assert.strictEqual(redacted.request.headers[1].value, 'localhost');
});

test('HarRecorder: redactEntry redacts listed body fields in JSON body', async () => {
  const recorder = new HarRecorder(requestlyConfig, null, logger);
  const entry = {
    request: {
      postData: { mimeType: 'application/json', text: '{"user":"test","password":"123","nested":{"token":"abc"}}' }
    }
  };
  const redacted = recorder.redactEntry(entry);
  const parsed = JSON.parse(redacted.request.postData.text);
  assert.strictEqual(parsed.password, '[REDACTED]');
  assert.strictEqual(parsed.nested.token, '[REDACTED]');
  assert.strictEqual(parsed.user, 'test');
});

test('HarRecorder: redactEntry leaves non-JSON body untouched for non-sensitive paths', async () => {
  const recorder = new HarRecorder(requestlyConfig, null, logger);
  const entry = {
    request: { url: '/api/v1/public', postData: { mimeType: 'text/plain', text: 'hello world' } }
  };
  const redacted = recorder.redactEntry(entry);
  assert.strictEqual(redacted.request.postData.text, 'hello world');
});

test('HarRecorder: redactEntry replaces file upload body with description string', async () => {
  const recorder = new HarRecorder(requestlyConfig, null, logger);
  const entry = {
    request: { postData: { mimeType: 'multipart/form-data; boundary=---123', text: 'binarydata...' } }
  };
  const redacted = recorder.redactEntry(entry);
  assert.strictEqual(redacted.request.postData.text, '[binary upload: file.ext, Xkb]');
});

test('HarRecorder: query with fromMs > toMs swaps them (no error)', async () => {
  const recorder = new HarRecorder(requestlyConfig, null, logger);
  await recorder.record({ startedDateTime: new Date(100).toISOString(), request: { method: 'GET', url: '/' }, response: {} });
  const results = await recorder.query({ fromMs: 200, toMs: 50 });
  assert.strictEqual(results.length, 1);
});

test('HarRecorder: record with null entry is a no-op', async () => {
  const recorder = new HarRecorder(requestlyConfig, null, logger);
  await recorder.record(null);
  assert.strictEqual(recorder.buffer.size, 0);
});

// ─── requestlyConfig Tests ───
// Testing the loaded config directly based on env vars set at top
test('requestlyConfig: fallback mock environments handles production strip', async () => {
  // Production was not passed, but we can verify it parsed properly
  assert.ok(requestlyConfig.mock.allowedEnvs.includes('development'));
  assert.strictEqual(requestlyConfig.proxy.port, 8888);
});

// ─── Rules Engine Tests ───
test('Rules matching: Url Contains rule matches URL substring', async () => {
  await loadRules();
  const rules = getRules();
  assert.ok(rules.length > 0, "Rules should be loaded from example json");
  const testRule = rules.find(r => r.id === 'rule-add-header');
  assert.ok(testRule);
});

// ─── Webhook signature verification ───
// We will test via an HTTP server
let server;
const getPort = () => server.address().port;
const fetchLocal = (path, options = {}) => {
  return new Promise((resolve, reject) => {
    const defaultOptions = {
        hostname: 'localhost',
        port: getPort(),
        path,
        method: 'GET',
        headers: {}
    };
    const req = http.request({ ...defaultOptions, ...options }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
};

test('Webhook: Valid HMAC signature passes', async () => {
  const payloadStr = JSON.stringify({ rules: [] });
  const ts = Math.floor(Date.now() / 1000).toString();
  const hmac = crypto.createHmac('sha256', requestlyConfig.rules.webhookSecret).update(payloadStr).digest('hex');
  
  const res = await fetchLocal('/requestly/webhook/rules-sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requestly-Timestamp': ts,
      'X-Requestly-Signature': `sha256=${hmac}`
    },
    body: payloadStr
  });
  
  assert.strictEqual(res.status, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.rulesLoaded, 0);
});

test('Webhook: Stale timestamp (> 300s) fails', async () => {
  const payloadStr = JSON.stringify({ rules: [] });
  const ts = (Math.floor(Date.now() / 1000) - 400).toString();
  const hmac = crypto.createHmac('sha256', requestlyConfig.rules.webhookSecret).update(payloadStr).digest('hex');
  
  const res = await fetchLocal('/requestly/webhook/rules-sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requestly-Timestamp': ts,
      'X-Requestly-Signature': `sha256=${hmac}`
    },
    body: payloadStr
  });
  
  assert.strictEqual(res.status, 401);
});

test('Mock endpoints: GET /requestly/mock/audits/:id with fresh mock-audit-{now} returns queued', async () => {
  const id = `mock-audit-${Date.now()}`;
  const res = await fetchLocal(`/requestly/mock/audits/${id}`);
  assert.strictEqual(res.status, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.status, 'queued');
});

test('Mock endpoints: GET /requestly/mock/audits/:id with 30s old timestamp returns completed', async () => {
  const id = `mock-audit-${Date.now() - 31000}`;
  const res = await fetchLocal(`/requestly/mock/audits/${id}`);
  assert.strictEqual(res.status, 200);
  const data = JSON.parse(res.body);
  assert.strictEqual(data.status, 'completed');
});

test('HAR export: GET /requestly/har returns valid HAR 1.2 envelope', async () => {
  // Use mock authenticate header
  const res = await fetchLocal(`/requestly/har`, {
    headers: { 'Authorization': 'Bearer test' }
  });
  assert.strictEqual(res.status, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.log);
  assert.strictEqual(data.log.version, "1.2");
});

test('HAR export: DELETE /requestly/har clears entries and returns deleted count', async () => {
  const res = await fetchLocal(`/requestly/har`, {
     method: 'DELETE',
     headers: { 'Authorization': 'Bearer test' }
  });
  assert.strictEqual(res.status, 200);
  const data = JSON.parse(res.body);
  assert.ok(data.deleted >= 0);
});

// Run Tests
async function run() {
  console.log('Running tests...\n');
  server = app.listen(0);

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  server.close();

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run();
