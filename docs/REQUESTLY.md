# Requestly Integration for ComplyNow

## Overview
Requestly is an HTTP interceptor and API mocking tool used alongside ComplyNow to allow QA engineers and developers to test out ComplyNow's complex pipeline. Due to strict database constraints and lengthy analysis durations during a real compliance audit, a backend integration handles capturing and mapping external mocked APIs immediately within the ComplyNow interface.

## Setup
1. Download Requestly Desktop App and install it.
2. Ensure you have the ComplyNow environment setup correctly. Check `docker-compose.yml` to run Postgres, Redis, and Mongo.
3. Configure the env vars:
   ```env
   REQUESTLY_ENABLED=true
   REQUESTLY_PROXY_ENABLED=true
   REQUESTLY_PROXY_PORT=8888
   ```

## Developer Workflow
- After enabling `REQUESTLY_PROXY_ENABLED`, all external requests initiated by `npm run dev` in ComplyNow get routed through `localhost:8888`.
- Start a mock test using the network rules in Requestly.

## Mock Endpoints
| Endpoint | Description |
| ---------| ------------|
| `GET /requestly/health` | Health Check |
| `POST /requestly/mock/audits` | Queue a fake audit, return ID. |
| `GET /requestly/mock/audits/:id` | Simulates an audit pipeline state transitions depending on timestamps |
| `GET /requestly/mock/audits/:id/report` | Produces a full mocked compliance report with simulated GDPR rules evaluated. |

## HAR Export
To review past API requests handled by ComplyNow, we utilize an in-memory & redis persisted circular buffer.

Export Traffic into HAR via:
`GET /requestly/har?fromMs&toMs&auditJobId=XYZ`
(Authorization header require: `Bearer <token>`)

Import this `.har` file into Requestly to review headers, timing, and errors. PII in body and designated HTTP headers are redacted automatically.

## Rules Engine
Store your declarative configurations in `requestly-rules.json`. See the `requestly-rules.example.json` file.
Supported actions natively on the backend:
- `delay`
- `blockRequest`
- `mockResponse`
- `addHeader`
- `removeHeader`
- `modifyResponse`

## Webhook Sync
The `POST /requestly/webhook/rules-sync` endpoint takes exported JSON payload matching Requestly's schema.
Validate with `X-Requestly-Signature` holding an HMAC SHA-256 string, signed using `REQUESTLY_WEBHOOK_SECRET`.

## Edge Cases & Troubleshooting
1. **Redis Down**: Our backend intelligently falls back to purely memory buffers for HAR records, and disk files for Rules parsing. 
2. **Missing Cert**: Providing MITM SSL through Requestly requires setting `REQUESTLY_PROXY_SSL=true`. Do not enable this flag in production.

## Security Notes
- Mocks disabled securely when `NODE_ENV === 'production'`.
- HAR recordings explicitly drop Multipart payload data (`[binary upload: ...]`).
- `modifyResponse` rules utilizing Javascript Evaluation `Code` will be strictly banned away from production environments.
