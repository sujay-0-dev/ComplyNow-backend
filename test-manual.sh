#!/bin/bash
# Manual testing script for ComplyNow Requestly Integration
# Start
npm run dev
# If error aquired
fuser -k 3000/tcp
#Check the Databases and Redis Health
echo "----------------------------------------"
echo "1. Checking Health Endpoint"
echo "----------------------------------------"
curl -s http://localhost:3000/api/v1/health | jq || curl -s http://localhost:3000/api/v1/health
echo -e "\n\n"

echo "----------------------------------------"
echo "2. Triggering a Mock Audit Queue"
echo "----------------------------------------"
AUDIT_ID=$(curl -s -X POST http://localhost:3000/requestly/mock/audits | jq -r '.auditJobId')
echo "Queued Audit ID: $AUDIT_ID"
echo -e "\n\n"

# Or 
# 1. Create the audit and save the ID dynamically
AUDIT_ID=$(curl -s -X POST http://localhost:3000/requestly/mock/audits | jq -r '.auditJobId')
echo "Saved ID: $AUDIT_ID"

echo "----------------------------------------"
echo "3. Fetching Mock Audit Status"
echo "----------------------------------------"
curl -s http://localhost:3000/requestly/mock/audits/$AUDIT_ID | jq || curl -s http://localhost:3000/requestly/mock/audits/$AUDIT_ID
echo -e "\n\n"

echo "----------------------------------------"
echo "4. Checking Requestly Integration Status"
echo "----------------------------------------"
curl -s -H "Authorization: Bearer mock-token" http://localhost:3000/requestly/status | jq || curl -s -H "Authorization: Bearer mock-token" http://localhost:3000/requestly/status
echo -e "\n\n"

echo "----------------------------------------"
echo "5. Exporting HAR (Traffic Recording)"
echo "----------------------------------------"
curl -s -H "Authorization: Bearer mock-token" "http://localhost:3000/requestly/har?format=json" | jq || curl -s -H "Authorization: Bearer mock-token" "http://localhost:3000/requestly/har?format=json"
echo -e "\n\n"

echo "----------------------------------------"
echo "6. Syncing Webhook Rules"
echo "----------------------------------------"
# Create a valid HMAC signature for dummy payload
PAYLOAD='{"rules":[{"id":"test-1","name":"Test Rule","ruleType":"delay","status":"Active","pairs":[{"source":{"key":"Path","operator":"Contains","value":"/api/v1/health"},"delay":1000}]}]}'
SECRET="my_super_secret_webhook_key_1234"
TS=$(date +%s)

# Requires Node.js to easily generate the HMAC for testing
SIG=$(node -e "console.log(require('crypto').createHmac('sha256', '$SECRET').update(JSON.stringify($PAYLOAD)).digest('hex'))")

curl -s -X POST http://localhost:3000/requestly/webhook/rules-sync \
  -H "Content-Type: application/json" \
  -H "X-Requestly-Timestamp: $TS" \
  -H "X-Requestly-Signature: sha256=$SIG" \
  -d "$PAYLOAD" | jq || curl -s -X POST http://localhost:3000/requestly/webhook/rules-sync \
  -H "Content-Type: application/json" \
  -H "X-Requestly-Timestamp: $TS" \
  -H "X-Requestly-Signature: sha256=$SIG" \
  -d "$PAYLOAD"
echo -e "\n\n"

echo "----------------------------------------"
echo "7. Testing FastAPI Worker Integration (POST /api/v1/audits)"
echo "----------------------------------------"
# Note: Unless the Python FastAPI worker is running at localhost:8000,
# this will correctly return an expected 500 "Worker integration error".
WORKER_PAYLOAD='{
  "auditMode": "document",
  "privacyPolicyText": "We share your data with everyone."
}'

curl -s -X POST http://localhost:3000/api/v1/audits \
  -H "Content-Type: application/json" \
  -d "$WORKER_PAYLOAD" | jq || curl -s -X POST http://localhost:3000/api/v1/audits \
  -H "Content-Type: application/json" \
  -d "$WORKER_PAYLOAD"
echo -e "\n\n"

echo "Done! The Requestly mock features and Worker Integration endpoints should now be fully tested."
