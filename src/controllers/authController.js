const pool = require("../config/db"); // your pg connection
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// 🔹 REGISTER USER
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // check if user exists
    const existingUser = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: "User already exists" });
    }

    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // insert user
    const newUser = await pool.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, email",
      [name, email, hashedPassword]
    );

    res.status(201).json({
      message: "User registered successfully",
      user: newUser.rows[0],
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


// 🔹 LOGIN USER
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // check user
    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const dbUser = user.rows[0];

    // compare password
    const isMatch = await bcrypt.compare(password, dbUser.password);

    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // generate JWT
    const token = jwt.sign(
      {
        id: dbUser.id,
        email: dbUser.email
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      message: "Login successful",
      token,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};