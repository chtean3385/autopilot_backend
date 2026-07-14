const crypto = require('crypto');
const pool = require('../config/db');

const TOKEN_SECRET = process.env.UNSUBSCRIBE_SECRET || 'dreams_unsubscribe_secret_2024';

function normalize(email) {
  return String(email || '').toLowerCase().trim();
}

function sign(email) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(email).digest('hex').slice(0, 32);
}

class SuppressionService {
  static async isSuppressed(email) {
    if (!email) return false;
    const result = await pool.query(
      'SELECT 1 FROM suppression_list WHERE email = $1',
      [normalize(email)]
    );
    return result.rows.length > 0;
  }

  static async addToSuppression(email, reason) {
    const normalized = normalize(email);
    const result = await pool.query(
      `INSERT INTO suppression_list (email, reason)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET reason = suppression_list.reason
       RETURNING *`,
      [normalized, reason || 'unsubscribed']
    );
    return result.rows[0];
  }

  // Signed, self-contained token so unsubscribe links work without auth/login
  // and can't be forged or used to enumerate/unsubscribe other addresses.
  static generateToken(email) {
    const normalized = normalize(email);
    return Buffer.from(`${normalized}:${sign(normalized)}`).toString('base64url');
  }

  // Returns the lowercased email if the token is valid, otherwise null
  static verifyToken(token) {
    try {
      const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
      const idx = decoded.lastIndexOf(':');
      if (idx === -1) return null;
      const email = decoded.slice(0, idx);
      const sigBuf = Buffer.from(decoded.slice(idx + 1));
      const expBuf = Buffer.from(sign(email));
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
      return email;
    } catch {
      return null;
    }
  }
}

module.exports = SuppressionService;
