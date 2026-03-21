// Dummy authenticate middleware for testing
function authenticate(req, res, next) {
  // Mock JWT verification logic for testing Requestly endpoints that require auth
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  
  // Attach dummy user
  req.user = { id: 'test-user', role: 'admin' };
  next();
}

module.exports = authenticate;
