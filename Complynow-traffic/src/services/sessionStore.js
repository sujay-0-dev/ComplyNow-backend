const { Mutex } = require('async-mutex');
const config = require('../config');

class SessionStore {
  constructor() {
    this._sessions = {};
    this._lock = new Mutex();
  }

  async create(sessionId, auditId, targetUrl = "") {
    return await this._lock.runExclusive(async () => {
      this._sessions[sessionId] = {
        audit_id: auditId,
        target_url: targetUrl,
        entries: [],
        created_at: new Date(),
        last_flush: new Date(),
        status: "active",
        total_flushed: 0,
      };
      return this._sessions[sessionId];
    });
  }

  async addEntry(sessionId, entry) {
    return await this._lock.runExclusive(async () => {
      if (!this._sessions[sessionId]) {
        return 0;
      }
      this._sessions[sessionId].entries.push(entry);
      return this._sessions[sessionId].entries.length;
    });
  }

  async flush(sessionId) {
    return await this._lock.runExclusive(async () => {
      if (!this._sessions[sessionId]) {
        return [];
      }
      const entries = [...this._sessions[sessionId].entries];
      this._sessions[sessionId].entries = [];
      this._sessions[sessionId].last_flush = new Date();
      this._sessions[sessionId].total_flushed += entries.length;
      return entries;
    });
  }

  async end(sessionId) {
    return await this._lock.runExclusive(async () => {
      if (!this._sessions[sessionId]) {
        return {};
      }
      const session = this._sessions[sessionId];
      delete this._sessions[sessionId];
      session.status = "ended";
      return session;
    });
  }

  async cleanupExpired() {
    const cutoff = Date.now() - (config.SESSION_TTL_SECONDS * 1000);
    return await this._lock.runExclusive(async () => {
      const expired = [];
      for (const [sid, s] of Object.entries(this._sessions)) {
        if (s.created_at.getTime() < cutoff) {
          expired.push(sid);
        }
      }
      for (const sid of expired) {
        delete this._sessions[sid];
      }
    });
  }
}

module.exports = new SessionStore();
