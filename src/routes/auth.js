const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { query } = require('../db/postgres');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-complynow-key';

// Nodemailer Setup
let transporter;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_PORT == 465, // true for 465, false for 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOtpEmail(email, otp) {
  const mailOptions = {
    from: process.env.SMTP_FROM || '"ComplyNow Security" <no-reply@complynow.io>',
    to: email,
    subject: 'Your ComplyNow Verification Code',
    text: `Your verification code is: ${otp}\nThis code will expire in 10 minutes.`
  };
  
  // Always log OTP so it's visible in console even if SMTP fails
  console.log(`[OTP GENERATED] Email: ${email} | Code: ${otp}`);
  
  if (transporter) {
    try {
      await transporter.sendMail(mailOptions);
    } catch (err) {
      console.error('Failed to send OTP via SMTP:', err.message);
    }
  }
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    const userId = uuidv4();
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60000);

    // Save user with unverified state
    await query(
      'INSERT INTO users (id, name, email, password_hash, otp_code, otp_expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, name, email, hash, otp, expiresAt]
    );

    sendOtpEmail(email, otp);

    res.status(201).json({ message: 'User registered. Please verify your email with the OTP sent.', email });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await query('SELECT id, name, email, password_hash, is_verified FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.is_verified) {
      return res.status(403).json({ error: 'User not verified', requiresOtp: true, email: user.email });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    if (user.is_verified) return res.status(400).json({ error: 'User already verified' });
    
    if (user.otp_code !== otp) return res.status(401).json({ error: 'Invalid OTP' });
    if (new Date(user.otp_expires_at) < new Date()) return res.status(401).json({ error: 'OTP expired' });

    await query('UPDATE users SET is_verified = true, otp_code = null, otp_expires_at = null WHERE email = $1', [email]);

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'OTP verification failed', details: err.message });
  }
});

router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const result = await query('SELECT id, is_verified FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    if (user.is_verified) return res.status(400).json({ error: 'User already verified' });

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60000);

    await query('UPDATE users SET otp_code = $1, otp_expires_at = $2 WHERE email = $3', [otp, expiresAt, email]);
    
    sendOtpEmail(email, otp);
    res.json({ message: 'OTP resent successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend OTP', details: err.message });
  }
});

module.exports = router;
