const { z } = require('zod');

const PerceiverEntry = z.object({
  session_id: z.string(),
  url: z.string(),
  method: z.string(),
  status: z.number(),
  request_headers: z.record(z.string()).optional().default({}),
  response_headers: z.record(z.string()).optional().default({}),
  request_body: z.string().nullable().optional(),
  response_body: z.string().nullable().optional(),
  timestamp: z.string(),
  duration_ms: z.number().nullable().optional()
});

const SessionCreateRequest = z.object({
  audit_id: z.string(),
  target_url: z.string().nullable().optional()
});

const FixRulesRequest = z.object({
  audit_id: z.string(),
  fix_simulations: z.array(z.any())
});

const ProbeRequest = z.object({
  url: z.string()
});

module.exports = {
  PerceiverEntry,
  SessionCreateRequest,
  FixRulesRequest,
  ProbeRequest
};
