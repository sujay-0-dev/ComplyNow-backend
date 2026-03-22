function assemble(entries, targetUrl = "") {
  const harEntries = entries.map(entry => {
    return {
      startedDateTime: entry.timestamp,
      time: entry.duration_ms || 0,
      request: {
        method: entry.method,
        url: entry.url,
        headers: Object.entries(entry.request_headers || {}).map(([name, value]) => ({ name, value })),
        postData: entry.request_body ? {
          mimeType: "application/json",
          text: entry.request_body
        } : undefined,
      },
      response: {
        status: entry.status,
        headers: Object.entries(entry.response_headers || {}).map(([name, value]) => ({ name, value })),
        content: {
          mimeType: "application/json",
          text: entry.response_body || ""
        }
      }
    };
  });

  return {
    log: {
      version: "1.2",
      creator: {
        name: "ComplyNow Traffic Layer",
        version: "1.0"
      },
      entries: harEntries
    }
  };
}

module.exports = { assemble };
