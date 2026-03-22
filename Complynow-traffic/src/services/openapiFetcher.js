const axios = require('axios');

async function probeUrl(url) {
  try {
    const response = await axios.get(url, { timeout: 5000 });
    return {
      url,
      spec: response.data,
      ok: true
    };
  } catch (err) {
    return {
      url,
      spec: null,
      ok: false
    };
  }
}

async function fetchOpenApiSpec(baseUrl) {
  const paths = [
    '/openapi.json',
    '/swagger.json',
    '/api-docs',
    '/api/openapi.json',
    '/api/swagger.json',
    '/docs/openapi.json',
    '/v1/openapi.json',
    '/v2/openapi.json'
  ];

  let baseObj;
  try {
    baseObj = new URL(baseUrl);
  } catch {
    return { spec: null, url: null };
  }
  const cleanBase = `${baseObj.protocol}//${baseObj.host}`;

  const tasks = paths.map(p => probeUrl(`${cleanBase}${p}`));
  const results = await Promise.all(tasks);

  for (const res of results) {
    if (res.ok && typeof res.spec === 'object' && res.spec) {
      if (res.spec.openapi || res.spec.swagger) {
        return { spec: res.spec, url: res.url };
      }
    }
  }
  return { spec: null, url: null };
}

async function probeBase(baseUrl) {
  try {
    const start = Date.now();
    const response = await axios.get(baseUrl, { timeout: 5000 });
    const durationMs = Date.now() - start;

    return {
      ok: true,
      headers: response.headers,
      durationMs
    };
  } catch (err) {
    return {
      ok: false,
      headers: err.response ? err.response.headers : {},
      durationMs: null
    };
  }
}

async function probe(baseUrl) {
  const [openapiPayload, basePayload] = await Promise.all([
    fetchOpenApiSpec(baseUrl),
    probeBase(baseUrl)
  ]);

  const headers = basePayload.headers || {};
  
  return {
    url: baseUrl,
    openapi_spec: openapiPayload.spec,
    openapi_url: openapiPayload.url,
    security_headers: {
      "strict-transport-security": headers['strict-transport-security'] || null,
      "x-content-type-options": headers['x-content-type-options'] || null,
      "x-frame-options": headers['x-frame-options'] || null,
      "content-security-policy": headers['content-security-policy'] || null,
      "referrer-policy": headers['referrer-policy'] || null,
      "permissions-policy": headers['permissions-policy'] || null,
    },
    is_https: baseUrl.startsWith('https://'),
    response_time_ms: basePayload.durationMs
  };
}

module.exports = { probe };
