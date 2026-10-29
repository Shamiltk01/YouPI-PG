import crypto from 'node:crypto';
import { mapMaybe } from '../maybe.js';

export class ReceivingAccountRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Creates a new receiving UPI account.
   * If isActive is true, atomically deactivates any other active accounts for this merchant.
   * Enforces that maximum ONE VPA may be active per merchant.
   */
  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const isActive = data.isActive !== undefined ? Boolean(data.isActive) : true;
    const isMerchantEnabled = data.isMerchantEnabled !== undefined ? Boolean(data.isMerchantEnabled) : true;

    return this.db.transaction(() => {
      const insert = () => mapMaybe(this.db.execute(`
        INSERT INTO payment_receiving_accounts (
          id, merchant_id, upi_id, payee_name, is_merchant_enabled,
          is_active, is_slot_busy, current_active_session_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        data.merchantId,
        data.upiId.trim(),
        data.payeeName.trim(),
        isMerchantEnabled ? 1 : 0,
        isActive ? 1 : 0,
        0,
        null,
        now,
        now
      ]), () => this.findById(id));

      if (!isActive) return insert();

      // If this new account is marked active, atomically deactivate existing accounts first.
      return mapMaybe(this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = 0, updated_at = ?
          WHERE merchant_id = ?
        `, [now, data.merchantId]), insert);
    });
  }

  findById(id) {
    return mapMaybe(this.db.queryOne('SELECT * FROM payment_receiving_accounts WHERE id = ?', [id]), row => row ? this.mapRow(row) : null);
  }

  findByMerchantId(merchantId) {
    return mapMaybe(this.db.query(
      'SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? ORDER BY is_active DESC, created_at ASC',
      [merchantId]
    ), rows => rows.map(r => this.mapRow(r)));
  }

  findActiveForMerchant(merchantId) {
    return mapMaybe(this.db.queryOne(
      'SELECT * FROM payment_receiving_accounts WHERE merchant_id = ? AND is_active = 1 LIMIT 1',
      [merchantId]
    ), row => row ? this.mapRow(row) : null);
  }

  /**
   * Atomically activates an account and deactivates all other accounts for this merchant.
   * Backend invariant: At most ONE VPA active per merchant.
   */
  activateAccount(merchantId, accountId) {
    return this.db.transaction(() => {
      const now = new Date().toISOString();

      // Deactivate all existing accounts for this merchant
      return mapMaybe(this.db.execute(`
        UPDATE payment_receiving_accounts
        SET is_active = 0, updated_at = ?
        WHERE merchant_id = ?
      `, [now, merchantId]), () => mapMaybe(this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = 1, updated_at = ?
          WHERE id = ? AND merchant_id = ?
        `, [now, accountId, merchantId]), () => this.findById(accountId)));
    });
  }

  /**
   * Deactivates a specific account.
   */
  deactivateAccount(merchantId, accountId) {
    const now = new Date().toISOString();
    return mapMaybe(this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_active = 0, updated_at = ?
      WHERE id = ? AND merchant_id = ?
    `, [now, accountId, merchantId]), () => this.findById(accountId));
  }

  /**
   * Updates an existing account's details.
   */
  updateAccount(id, data) {
    return this.db.transaction(() => {
      return mapMaybe(this.findById(id), existing => {
        if (!existing) return null;

        const now = new Date().toISOString();
        const upiId = data.upiId !== undefined ? data.upiId.trim() : existing.upiId;

        if (existing.isSlotBusy && data.upiId !== undefined && upiId !== existing.upiId) {
          throw new Error('Cannot change UPI ID while receiving account slot is currently busy with an active payment session.');
        }

        const payeeName = data.payeeName !== undefined ? data.payeeName.trim() : existing.payeeName;
        const isMerchantEnabled = data.isMerchantEnabled !== undefined ? Boolean(data.isMerchantEnabled) : existing.isMerchantEnabled;
        const update = () => mapMaybe(this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = ?, is_merchant_enabled = ?, ${data.isActive === true ? 'is_active = 1, ' : data.isActive === false ? 'is_active = 0, ' : ''}updated_at = ?
          WHERE id = ?
        `, [upiId, payeeName, isMerchantEnabled ? 1 : 0, now, id]), () => this.findById(id));

        if (data.isActive === true) {
          return mapMaybe(this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_active = 0, updated_at = ?
          WHERE merchant_id = ?
          `, [now, existing.merchantId]), update);
        }

        return update();
      });
    });
  }

  /**
   * Deletes a receiving account.
   * Throws if the slot is currently busy.
   */
  deleteAccount(merchantId, accountId) {
    return mapMaybe(this.findById(accountId), account => {
      if (!account || account.merchantId !== merchantId) {
        throw new Error(`Account not found or does not belong to merchant: ${accountId}`);
      }

      if (account.isSlotBusy || account.currentActiveSessionId) {
        throw new Error(`Cannot delete account ${account.upiId} because it has an active checkout session.`);
      }

      return mapMaybe(this.db.execute('DELETE FROM payment_receiving_accounts WHERE id = ? AND merchant_id = ?', [accountId, merchantId]), () => true);
    });
  }

  /**
   * Sets slot busy status and currently active session ID.
   */
  setSlotStatus(id, isBusy, activeSessionId = null) {
    const now = new Date().toISOString();
    return mapMaybe(this.db.execute(`
      UPDATE payment_receiving_accounts
      SET is_slot_busy = ?, current_active_session_id = ?, updated_at = ?
      WHERE id = ?
    `, [isBusy ? 1 : 0, activeSessionId, now, id]), () => this.findById(id));
  }

  /**
   * Updates or creates the active receiving UPI account for a merchant.
   * @param {string} merchantId
   * @param {string} upiId
   * @param {string} [payeeName]
   * @param {boolean} [isMerchantEnabled=true]
   */
  upsertActiveForMerchant(merchantId, upiId, payeeName = null, isMerchantEnabled = true) {
    const cleanUpi = upiId.trim();
    return mapMaybe(this.findActiveForMerchant(merchantId), existing => {
      const now = new Date().toISOString();

      if (existing) {
        return mapMaybe(this.db.execute(`
          UPDATE payment_receiving_accounts
          SET upi_id = ?, payee_name = COALESCE(?, payee_name), is_merchant_enabled = ?, updated_at = ?
          WHERE id = ?
        `, [cleanUpi, payeeName?.trim() || null, isMerchantEnabled ? 1 : 0, now, existing.id]), () => this.findById(existing.id));
      }

      return this.create({
        merchantId,
        upiId: cleanUpi,
        payeeName: payeeName?.trim() || 'Merchant Store',
        isMerchantEnabled,
        isActive: true
      });
    });
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      upiId: row.upi_id,
      payeeName: row.payee_name,
      isMerchantEnabled: Boolean(row.is_merchant_enabled !== undefined ? row.is_merchant_enabled : 1),
      isActive: Boolean(row.is_active),
      isSlotBusy: Boolean(row.is_slot_busy),
      currentActiveSessionId: row.current_active_session_id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
