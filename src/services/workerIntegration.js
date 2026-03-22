const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * 1. Fetching OpenAPI spec from base URL
 */
async function fetchOpenApiSpec(baseUrl) {
  const paths = ['/openapi.json', '/swagger.json', '/api-docs'];
  
  for (const path of paths) {
    try {
      // Create explicit base-relative URL, safely
      const targetUrl = new URL(path, baseUrl).toString();
      logger.debug(`Attempting to fetch OpenAPI spec from ${targetUrl}`);
      const response = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
      
      if (response.ok) {
        const data = await response.json();
        // Naive validation
        if (data && (data.openapi || data.swagger) && data.paths) {
          logger.info(`Found valid OpenAPI spec at ${targetUrl}`);
          return data;
        }
      }
    } catch (err) {
      logger.debug(`Failed to fetch from ${path}: ${err.message}`);
    }
  }
  
  return null;
}

/**
 * 2. Probing security headers
 */
async function probeSecurityHeaders(baseUrl) {
  const paths = ['/health', '/'];
  
  for (const path of paths) {
    try {
      const targetUrl = new URL(path, baseUrl).toString();
      logger.debug(`Probing security headers at ${targetUrl}`);
      const response = await fetch(targetUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
      
      const strictTransportSecurity = response.headers.get('strict-transport-security');
      const xContentTypeOptions = response.headers.get('x-content-type-options');
      const xFrameOptions = response.headers.get('x-frame-options');
      const contentSecurityPolicy = response.headers.get('content-security-policy');

      return {
        "strict-transport-security": strictTransportSecurity,
        "x-content-type-options": xContentTypeOptions,
        "x-frame-options": xFrameOptions,
        "content-security-policy": contentSecurityPolicy
      };
    } catch (err) {
      logger.debug(`Failed to probe ${path}: ${err.message}`);
    }
  }
  
  return null;
}

/**
 * 3. Fetch privacy policy text
 */
async function fetchPrivacyPolicy(url) {
  if (!url) return null;
  
  try {
    logger.debug(`Fetching privacy policy from ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
        let text = await response.text();
        return text.trim().slice(0, 50000);
    }
  } catch (err) {
    logger.warn(`Failed to fetch privacy policy: ${err.message}`);
  }
  return null;
}

/**
 * 4. Validate HAR
 */
function validateHar(harObject) {
  if (!harObject) return null;
  if (harObject.log && Array.isArray(harObject.log.entries)) {
    if (harObject.log.entries.length === 0) return null;
    
    // Truncate to 500 entries per contract
    if (harObject.log.entries.length > 500) {
      logger.warn(`HAR has ${harObject.log.entries.length} entries. Truncating to 500.`);
      harObject.log.entries = harObject.log.entries.slice(0, 500);
    }
    return harObject;
  }
  return null;
}

/**
 * 5. Formatting Requestly Mock Rule
 */
function buildRequestlySharedList(fixSimulations) {
  if (!fixSimulations || fixSimulations.length === 0) return null;

  const rules = fixSimulations.map(sim => sim.requestly_rule).filter(Boolean);
  
  if (rules.length === 0) return null;

  return {
    "name": "ComplyNow Auto-Generated Security Fixes",
    "createdAt": Date.now(),
    "rules": rules
  };
}

/**
 * Main Orchestrator Route Wrapper
 * Submits to FastAPI Worker
 */
async function submitAuditToWorker({
  auditMode = 'document',
  privacyPolicyUrl,
  privacyPolicyText,
  apiText,
  dbSchemaText,
  harTraffic,
  targetBaseUrl
}) {
  const workerUrl = process.env.WORKER_URL || "http://localhost:8000";
  const requestId = crypto.randomUUID();
  let finalPrivacyText = privacyPolicyText || null;
  let openApiSpec = null;
  let probedHeaders = null;

  // Map frontend modes ('api', 'document', 'combined') to v2 worker modes ('traffic', 'document', 'combined')
  let mappedWorkerMode = (auditMode === 'api') ? 'traffic' : auditMode;
  if (!['document', 'traffic', 'combined'].includes(mappedWorkerMode)) {
    mappedWorkerMode = 'combined'; // Safe default
  }

  // 1 & 2. Probe BaseUrl details if provided. Frontend sends targetBaseUrl across all modes if scanning a URL.
  // In 'api'/'traffic' or 'combined' mode, we probe the API endpoints.
  if (targetBaseUrl && ['combined', 'traffic', 'api'].includes(auditMode)) {
    openApiSpec = await fetchOpenApiSpec(targetBaseUrl);
    probedHeaders = await probeSecurityHeaders(targetBaseUrl);
  }

  // 3. Privacy Policy. If privacyPolicyUrl is missing, use targetBaseUrl if they want a policy scanned.
  const policyTargetUrl = privacyPolicyUrl || (['combined', 'document'].includes(auditMode) ? targetBaseUrl : null);
  if (!finalPrivacyText && policyTargetUrl) {
    finalPrivacyText = await fetchPrivacyPolicy(policyTargetUrl);
  }

  // 4. Validate HAR
  const validatedHar = validateHar(harTraffic);

  // 5. Enforce Data Extraction before hitting worker (Fix for 100% compliant dead URLs)
  const hasDocuments = finalPrivacyText || apiText || dbSchemaText;
  const hasLiveData = validatedHar || openApiSpec || probedHeaders;
  
  if (!hasDocuments && !hasLiveData) {
    throw new Error("NO_DATA_EXTRACTED: Could not extract any valid compliance data from the remote URL or provided inputs.");
  }

  // Construct Contract v2.0 Request
  const requestPayload = {
    audit_mode: mappedWorkerMode,
    documents: {
      privacy_policy_text: finalPrivacyText ? finalPrivacyText.trim().slice(0, 50000) : null,
      api_text: apiText ? apiText.trim().slice(0, 50000) : null,
      db_schema_text: dbSchemaText ? dbSchemaText.trim().slice(0, 50000) : null
    },
    live_data: {
      har_traffic: validatedHar,
      openapi_spec: openApiSpec,
      probed_headers: probedHeaders
    }
  };

  logger.info(`Submitting audit [${requestId}] to worker: ${workerUrl}/run-audit`);

  try {
    const response = await fetch(`${workerUrl}/run-audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestPayload),
      // 5-minute timeout for deep AI analysis
      signal: AbortSignal.timeout(300000)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Worker responded with ${response.status}: ${errText}`);
    }

    const workerResponse = await response.json();

    const requestlyBundle = buildRequestlySharedList(workerResponse.fix_simulations);

    return {
      requestId,
      result: workerResponse,
      requestlyImportPayload: requestlyBundle || workerResponse.requestly_bundle || null
    };
  } catch (error) {
    logger.error(`Failed executing audit on worker: ${error.message}`);
    throw error;
  }
}

module.exports = {
  fetchOpenApiSpec,
  probeSecurityHeaders,
  fetchPrivacyPolicy,
  validateHar,
  buildRequestlySharedList,
  submitAuditToWorker
};
