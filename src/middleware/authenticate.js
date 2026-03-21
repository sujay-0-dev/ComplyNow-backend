// Dummy authenticate middleware for testing
// function authenticate(req, res, next) {
//   // Mock JWT verification logic for testing Requestly endpoints that require auth
//   const authHeader = req.headers.authorization;
//   if (!authHeader || !authHeader.startsWith('Bearer ')) {
//     return res.status(401).json({ error: 'Missing or invalid token' });
//   }
  
//   // Attach dummy user
//   req.user = { id: 'test-user', role: 'admin' };
//   next();
// }

// module.exports = authenticate;

const jwt = require("jsonwebtoken");

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized - No token" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // attach user info
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = authenticate;