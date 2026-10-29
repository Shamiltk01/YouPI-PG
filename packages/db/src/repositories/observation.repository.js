import crypto from 'node:crypto';
import { ObservationAttributionStatus } from '@youpi/common';
import { mapMaybe } from '../maybe.js';

export class ObservationRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const rawPayload = typeof data.rawPayload === 'object' ? JSON.stringify(data.rawPayload) : (data.rawPayload || '{}');

    const sql = `
      INSERT INTO payment_observations (
        id, receiving_account_id, source, amount_paise, observed_at,
        ingested_at, sender_vpa, bank_reference_number, fingerprint_hash,
        raw_payload, attribution_status, attributed_payment_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    return mapMaybe(this.db.execute(sql, [
      id,
      data.receivingAccountId,
      data.source,
      Number(data.amountPaise),
      data.observedAt.toISOString(),
      now,
      data.senderVpa || null,
      data.bankReferenceNumber || null,
      data.fingerprintHash,
      rawPayload,
      data.attributionStatus || ObservationAttributionStatus.UNATTRIBUTED,
      data.attributedPaymentId || null,
      now
    ]), () => this.findById(id));
  }

  findById(id) {
    return mapMaybe(this.db.queryOne('SELECT * FROM payment_observations WHERE id = ?', [id]), row => row ? this.mapRow(row) : null);
  }

  findByFingerprint(fingerprintHash) {
    return mapMaybe(this.db.queryOne('SELECT * FROM payment_observations WHERE fingerprint_hash = ?', [fingerprintHash]), row => row ? this.mapRow(row) : null);
  }

  findUnattributed(receivingAccountId) {
    return mapMaybe(this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ? AND attribution_status = ?
      ORDER BY observed_at ASC
    `, [receivingAccountId, ObservationAttributionStatus.UNATTRIBUTED]),
    rows => rows.map(r => this.mapRow(r)));
  }

  findByReceivingAccount(receivingAccountId, limit = 50) {
    return mapMaybe(this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ?
      ORDER BY observed_at DESC
      LIMIT ?
    `, [receivingAccountId, limit]),
    rows => rows.map(r => this.mapRow(r)));
  }

  markAttributed(id, paymentId) {
    return mapMaybe(this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?, attributed_payment_id = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.ATTRIBUTED, paymentId, id]), () => this.findById(id));
  }

  markDuplicate(id) {
    return mapMaybe(this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.DUPLICATE_IGNORED, id]), () => this.findById(id));
  }

  markAmbiguous(id) {
    return mapMaybe(this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.AMBIGUOUS, id]), () => this.findById(id));
  }

  markLateUnmatched(id) {
    return mapMaybe(this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.LATE_UNMATCHED, id]), () => this.findById(id));
  }

  mapRow(row) {
    return {
      id: row.id,
      receivingAccountId: row.receiving_account_id,
      source: row.source,
      amountPaise: BigInt(row.amount_paise),
      observedAt: new Date(row.observed_at),
      ingestedAt: new Date(row.ingested_at),
      senderVpa: row.sender_vpa,
      bankReferenceNumber: row.bank_reference_number,
      fingerprintHash: row.fingerprint_hash,
      rawPayload: JSON.parse(row.raw_payload || '{}'),
      attributionStatus: row.attribution_status,
      attributedPaymentId: row.attributed_payment_id,
      createdAt: new Date(row.created_at)
    };
  }
}
