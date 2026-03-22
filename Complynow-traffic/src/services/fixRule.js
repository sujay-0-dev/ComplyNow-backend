function extractPath(endpoint) {
  if (!endpoint) return "/";
  if (endpoint.startsWith("http")) {
    try {
      return new URL(endpoint).pathname;
    } catch {
      return endpoint;
    }
  }
  return endpoint.split("?")[0];
}

function ensureValidJson(body) {
  try {
    JSON.parse(body);
    return body;
  } catch {
    return '{"message": "OK"}';
  }
}

function buildHeaderScript(headers) {
  const lines = [
    "function modifyResponse(args) {",
    "  const { response } = args;"
  ];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`  response.headers["${name}"] = "${value}";`);
  }
  lines.push("  return response;");
  lines.push("}");
  return lines.join("\\n");
}

function build(auditId, fixSimulations) {
  const rules = [];

  for (const fix of fixSimulations) {
    const issueId = fix.issue_id || "UNKNOWN";
    const endpoint = fix.endpoint || "";
    const method = fix.method || "GET";
    const compliant = fix.compliant || {};

    const body = compliant.response_body || "";
    const headers = compliant.headers || {};
    const status = String(compliant.status_code || 200);

    const urlMatch = extractPath(endpoint);

    if (!body && Object.keys(headers).length === 0) {
      continue;
    }

    let responseConfig;
    if (body) {
      responseConfig = {
        type: "static",
        value: ensureValidJson(body),
        statusCode: status,
      };
    } else {
      responseConfig = {
        type: "code",
        value: buildHeaderScript(headers),
      };
    }

    rules.push({
      name: `ComplyNow Fix — ${issueId} — ${method} ${endpoint}`,
      ruleType: "RESPONSE",
      status: "Active",
      pairs: [
        {
          source: {
            key: "Url",
            operator: "Contains",
            value: urlMatch,
          },
          response: responseConfig,
        }
      ],
      description: `Auto-generated compliance fix by ComplyNow. Simulates compliant response for ${method} ${endpoint}. Rule: ${issueId}`,
    });
  }

  return {
    version: "2",
    rules: rules,
    groups: [
      {
        id: "complynow-fixes",
        name: "ComplyNow — Compliance Fixes",
        status: "Active",
      }
    ],
  };
}

module.exports = { build };
