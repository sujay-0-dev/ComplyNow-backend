const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const sessionStore = require('./services/sessionStore');

const perceiverRoutes = require('./routes/perceiver');
const probeRoutes = require('./routes/probe');
const requestlyRoutes = require('./routes/requestly');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Traffic captures can be large

// Ensure rules dir exists
const rulesDir = path.join(process.cwd(), config.RULES_DIR);
if (!fs.existsSync(rulesDir)) {
  fs.mkdirSync(rulesDir, { recursive: true });
}
app.use('/public', express.static(path.join(process.cwd(), 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: "ok",
    service: "complynow-traffic",
    version: "1.0.0",
    sessions_active: Object.keys(sessionStore._sessions).length
  });
});

app.use('/', perceiverRoutes);
app.use('/', probeRoutes);
// Mount requestly routes to catch both `/session/create` and `/requestly/fix-rules`
app.use('/', requestlyRoutes);
app.use('/requestly', requestlyRoutes);

// Cleanup loop
setInterval(() => {
  sessionStore.cleanupExpired().catch(err => console.error("Cleanup error", err));
}, 60000);

app.listen(config.TRAFFIC_PORT, config.TRAFFIC_HOST, () => {
  console.log(`ComplyNow Traffic Layer listening closely on ${config.TRAFFIC_HOST}:${config.TRAFFIC_PORT}`);
  console.log(`Public Base URL: ${config.PUBLIC_BASE_URL}`);
  console.log(`Backend Forwarding to: ${config.BACKEND_URL}${config.BACKEND_AUDIT_ENDPOINT}`);
});
