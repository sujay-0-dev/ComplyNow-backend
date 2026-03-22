const express = require('express');
const { ProbeRequest } = require('../models');
const openapiFetcher = require('../services/openapiFetcher');

const router = express.Router();

router.get('/probe', async (req, res) => {
  try {
    const query = ProbeRequest.parse(req.query);
    const result = await openapiFetcher.probe(query.url);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.issues || err.message });
  }
});

module.exports = router;
