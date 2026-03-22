const mongoose = require('mongoose');

const AuditReportSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  score: {
    type: Number,
    required: false
  },
  summary: {
    type: Object, // Stores critical/high/medium bounds
    required: false
  },
  issues: {
    type: Array,
    default: []
  },
  traffic_findings: {
    type: Array, // Holds HAR related data
    default: []
  },
  contradictions: {
    type: Array,
    default: []
  },
  fix_simulations: {
    type: Array,
    default: []
  },
  projected_score: {
    type: Object,
    required: false
  },
  meta: {
    type: Object,
    required: false
  },
  requestlyMockData: {
    type: Object, // Built schema rules
    required: false
  },
  fixes: {
    type: Object,
    default: {}
  },
  requestlyFixRules: {
    type: Object,
    required: false
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 604800 // Automatically deletes the massive JSON reports after 7 days (TTL) to save storage constraints!
  }
});

const AuditReport = mongoose.model('AuditReport', AuditReportSchema);

module.exports = AuditReport;
