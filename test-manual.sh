#!/bin/bash
# Manual testing script for ComplyNow Background Queue Integration

echo "----------------------------------------"
echo "1. Checking Health Endpoint"
echo "----------------------------------------"
curl -s http://localhost:3000/api/v1/health | jq || curl -s http://localhost:3000/api/v1/health
echo -e "\n\n"

echo "----------------------------------------"
echo "2. Triggering Async Audit Queue (Redis + BullMQ)"
echo "----------------------------------------"
WORKER_PAYLOAD='{
  "auditMode": "document",
  "privacyPolicyText": "We share your data with everyone."
}'

# We fetch the ID safely and store it
AUDIT_ID=$(curl -s -X POST http://localhost:3000/api/v1/audits \
  -H "Content-Type: application/json" \
  -d "$WORKER_PAYLOAD" | jq -r '.auditJobId')

echo "Queued Background Job ID: $AUDIT_ID"
curl http://localhost:3000/requestly/mock/audits/mock-audit-12345/report
echo -e "\n\n"

echo "----------------------------------------"
echo "3. Fetching Initial Audit Job Status"
echo "----------------------------------------"
curl -s http://localhost:3000/api/v1/audits/$AUDIT_ID | jq || curl -s http://localhost:3000/api/v1/audits/$AUDIT_ID
echo -e "\n\n"

echo "Wait 3 seconds for the task to be processed or fail..."
sleep 3

echo "----------------------------------------"
echo "4. Fetching Final Status / Progress"
echo "----------------------------------------"
curl -s http://localhost:3000/api/v1/audits/$AUDIT_ID | jq || curl -s http://localhost:3000/api/v1/audits/$AUDIT_ID
echo -e "\n\n"

echo "----------------------------------------"
echo "5. Fetching Final Report (400 if not 'completed' or 'failed')"
echo "----------------------------------------"
curl -s http://localhost:3000/api/v1/audits/$AUDIT_ID/report | jq || curl -s http://localhost:3000/api/v1/audits/$AUDIT_ID/report
echo -e "\n\n"

echo "Done! The async BullMQ endpoints have been explicitly tested."


# Requestly

curl http://localhost:3000/requestly/mock/audits/mock-audit-12345


curl http://localhost:3000/requestly/mock/audits/mock-audit-12345/report
echo -e "\n\n"
