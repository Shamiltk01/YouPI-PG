import crypto from 'node:crypto';
import { blindIndex, blindIndexMatches, safeEqual, issueDeviceCredential, verifyDeviceCredential } from '@youpi/common';
import { mapMaybe, runMaybe } from '../maybe.js';

/** Namespace so device-token digests never collide with other blind indexes. */
const INDEX_NS = 'devtok';

export class DeviceRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates or registers a new device record.
   * @param {{
   *   id?: string,
   *   customerId?: string|null,
   *   publicKey: string,
   *   fingerprintHash: string,
   *   userAgent?: string,
   *   platform?: string,
   *   browser?: string,
   *   timezone?: string,
   *   language?: string,
   *   screenSignature?: string,
   *   deviceToken?: string,
   *   status?: string
   * }} data
   */
  create(data) {
    const id = data.id || `dev_${crypto.randomUUID()}`;
    const deviceToken = data.deviceToken || issueDeviceCredential(id);
    const now = new Date().toISOString();
    const status = data.status || 'ACTIVE';

    const sql = `
      INSERT INTO devices (
        id, customer_id, public_key, fingerprint_hash, user_agent,
        platform, browser, timezone, language, screen_signature,
        device_token, status, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return mapMaybe(this.db.execute(sql, [
      id,
      data.customerId || null,
      data.publicKey,
      data.fingerprintHash,
      data.userAgent || null,
      data.platform || null,
      data.browser || null,
      data.timezone || null,
      data.language || null,
      data.screenSignature || null,
      // Only a keyed blind index is persisted: the raw token is never needed again and a
      // database dump must not yield usable device credentials.
      blindIndex(deviceToken, INDEX_NS),
      status,
      now,
      now
    ]), () => mapMaybe(this.findById(id), created => created ? { ...created, deviceToken } : null));
  }

  /**
   * Finds a device by its unique ID.
   * @param {string} id
   */
  findById(id) {
    if (!id) return null;
    return mapMaybe(this.db.queryOne('SELECT * FROM devices WHERE id = ?', [id]), row => row ? this.mapRow(row) : null);
  }

  /**
   * Verifies a presented device token for a specific device ID in constant time.
   * @param {string} deviceId
   * @param {string} presentedToken
   * @returns {boolean}
   */
  verifyToken(deviceId, presentedToken) {
    if (!deviceId || typeof deviceId !== 'string' || !presentedToken || typeof presentedToken !== 'string') {
      return false;
    }
    const repository = this;
    return runMaybe(function* () {
      const row = yield repository.db.queryOne(
        'SELECT id, device_token, status FROM devices WHERE id = ?',
        [deviceId]
      );
      if (!row || row.status !== 'ACTIVE' || !row.device_token) return false;

      if (presentedToken.startsWith(`devtok_${deviceId}.`) && !verifyDeviceCredential(deviceId, presentedToken)) {
        return false;
      }
      if (blindIndexMatches(presentedToken, row.device_token, INDEX_NS)) return true;

      if (safeEqual(presentedToken, row.device_token)) {
        try {
          yield repository.db.execute('UPDATE devices SET device_token = ? WHERE id = ?', [blindIndex(presentedToken, INDEX_NS), row.id]);
        } catch {}
        return true;
      }
      return false;
    });
  }

  /**
   * Rotates and issues a fresh server-signed device credential for an existing device.
   * @param {string} deviceId
   * @returns {string|null}
   */
  rotateToken(deviceId) {
    if (!deviceId) return null;
    const repository = this;
    return runMaybe(function* () {
      const row = yield repository.db.queryOne('SELECT id, status FROM devices WHERE id = ?', [deviceId]);
      if (!row || row.status !== 'ACTIVE') return null;
      const freshToken = issueDeviceCredential(deviceId);
      const now = new Date().toISOString();
      yield repository.db.execute(
        'UPDATE devices SET device_token = ?, last_seen_at = ? WHERE id = ?',
        [blindIndex(freshToken, INDEX_NS), now, deviceId]
      );
      return freshToken;
    });
  }

  /**
   * Finds a device by its active device token.
   * @param {string} token
   */
  findByToken(token) {
    if (!token) return null;
    const repository = this;
    return runMaybe(function* () {
      let row = yield repository.db.queryOne(
        'SELECT * FROM devices WHERE device_token = ? AND status = ?',
        [blindIndex(token, INDEX_NS), 'ACTIVE']
      );
      if (!row && typeof token === 'string' && token.startsWith('devtok_')) {
        const legacy = yield repository.db.queryOne(
          'SELECT * FROM devices WHERE device_token = ? AND status = ?',
          [token, 'ACTIVE']
        );
        if (legacy) {
          try {
            yield repository.db.execute('UPDATE devices SET device_token = ? WHERE id = ?', [blindIndex(token, INDEX_NS), legacy.id]);
          } catch {}
          row = legacy;
        }
      }
      return row ? repository.mapRow(row) : null;
    });
  }

  /**
   * Finds existing device by matching public key.
   * @param {string} publicKey
   */
  findByPublicKey(publicKey) {
    if (!publicKey) return null;
    return mapMaybe(this.db.queryOne('SELECT * FROM devices WHERE public_key = ? LIMIT 1', [publicKey]), row => row ? this.mapRow(row) : null);
  }

  /**
   * Finds existing device by customerId and fingerprint.
   * @param {string} customerId
   * @param {string} fingerprintHash
   */
  findByCustomerAndFingerprint(customerId, fingerprintHash) {
    if (!customerId || !fingerprintHash) return null;
    return mapMaybe(this.db.queryOne(
      'SELECT * FROM devices WHERE customer_id = ? AND fingerprint_hash = ? AND status = "ACTIVE" LIMIT 1',
      [customerId, fingerprintHash]
    ), row => row ? this.mapRow(row) : null);
  }

  /**
   * Finds all devices registered for a customer.
   * @param {string} customerId
   */
  findByCustomerId(customerId) {
    if (!customerId) return [];
    return mapMaybe(this.db.query(
      'SELECT * FROM devices WHERE customer_id = ? ORDER BY last_seen_at DESC',
      [customerId]
    ), rows => rows.map(r => this.mapRow(r)));
  }

  /**
   * Associates an existing device with a customer.
   * @param {string} deviceId
   * @param {string} customerId
   */
  associateCustomer(deviceId, customerId) {
    const now = new Date().toISOString();
    return mapMaybe(this.db.execute(
      'UPDATE devices SET customer_id = ?, last_seen_at = ? WHERE id = ?',
      [customerId, now, deviceId]
    ), () => this.findById(deviceId));
  }

  /**
   * Updates last seen timestamp for a device.
   * @param {string} deviceId
   */
  touch(deviceId) {
    if (!deviceId) return;
    try {
      const result = this.db.execute(
        'UPDATE devices SET last_seen_at = ? WHERE id = ?',
        [new Date().toISOString(), deviceId]
      );
      if (result && typeof result.then === 'function') return result.catch(() => undefined);
    } catch {}
  }

  /**
   * Updates device record.
   * @param {string} id
   * @param {Partial<any>} data
   */
  update(id, data) {
    const fields = [];
    const values = [];

    if (data.customerId !== undefined) {
      fields.push('customer_id = ?');
      values.push(data.customerId);
    }
    if (data.fingerprintHash !== undefined) {
      fields.push('fingerprint_hash = ?');
      values.push(data.fingerprintHash);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }
    if (data.deviceToken !== undefined) {
      fields.push('device_token = ?');
      values.push(blindIndex(data.deviceToken, INDEX_NS));
    }

    fields.push('last_seen_at = ?');
    values.push(new Date().toISOString());

    values.push(id);
    return mapMaybe(this.db.execute(`UPDATE devices SET ${fields.join(', ')} WHERE id = ?`, values), () => this.findById(id));
  }

  /**
   * Maps a database row to a clean camelCase object.
   * @param {any} row
   */
  mapRow(row) {
    return {
      id: row.id,
      customerId: row.customer_id,
      publicKey: row.public_key,
      fingerprintHash: row.fingerprint_hash,
      userAgent: row.user_agent,
      platform: row.platform,
      browser: row.browser,
      timezone: row.timezone,
      language: row.language,
      screenSignature: row.screen_signature,
      // Omitted: this column now holds a keyed blind index, not a usable credential.
      deviceToken: null,
      status: row.status,
      createdAt: new Date(row.created_at),
      lastSeenAt: new Date(row.last_seen_at)
    };
  }
}
