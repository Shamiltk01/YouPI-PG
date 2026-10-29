import { PaymentStatus } from '@youpi/common';
import { runMaybe } from '@youpi/db';

export class TimingEngine {
  /**
   * @param {{
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   queueEngine: import('./queue-engine.js').QueueEngine,
   *   eventEmitter?: { emit: (event: string, payload: any) => void },
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   activeDurationMs?: number,
   *   processingDurationMs?: number
   * }} options
   */
  constructor(options) {
    this.sessionRepo = options.sessionRepo;
    this.queueEngine = options.queueEngine;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    this.auditRepo = options.auditRepo;
    this.activeDurationMs = options.activeDurationMs || 300000; // 5 minutes
    this.processingDurationMs = options.processingDurationMs || 30000; // 30 seconds

    /** @type {Map<string, NodeJS.Timeout>} */
    this.activeTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.processingTimers = new Map();
  }

  /**
   * Starts Timer 1 (5-minute payment window) for an activated session.
   * @param {string} sessionId
   * @param {Date} expiresAt
   */
  startActiveTimer(sessionId, expiresAt) {
    this.clearTimers(sessionId);

    const delayMs = Math.max(0, expiresAt.getTime() - Date.now());

    const timer = setTimeout(() => {
      Promise.resolve(this.handleActiveTimerExpiration(sessionId)).catch(err => {
        console.error('[TimingEngine] Active timer expiration failed:', err.message);
      });
    }, delayMs);

    // Unref so timer doesn't prevent process exit if running standalone
    if (timer.unref) timer.unref();

    this.activeTimers.set(sessionId, timer);
  }

  /**
   * Executes when Timer 1 reaches 0 without customer clicking "Payment Done".
   * Transitions to EXPIRED and promotes next queued customer.
   * @param {string} sessionId
   */
  handleActiveTimerExpiration(sessionId) {
    this.activeTimers.delete(sessionId);
    const engine = this;
    return runMaybe(function* () {
      const session = yield engine.sessionRepo.findById(sessionId);
      if (!session || session.status !== PaymentStatus.ACTIVE) return;

      yield engine.sessionRepo.transitionToTerminal(sessionId, PaymentStatus.EXPIRED);
      if (engine.auditRepo) {
        yield engine.auditRepo.log({
          merchantId: session.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: sessionId,
          action: 'PAYMENT_EXPIRED_TIMEOUT',
          actorType: 'SYSTEM',
          details: { reason: '5-minute payment window elapsed without customer clicking Payment Done' }
        });
      }

      engine.eventEmitter.emit('SESSION.EXPIRED', { sessionId, receivingAccountId: session.receivingAccountId });
      engine.eventEmitter.emit('PAYMENT.EXPIRED', {
        paymentId: sessionId,
        orderId: session.orderId,
        merchantId: session.merchantId,
        amountPaise: session.amountPaise
      });

      if (session.receivingAccountId) {
        yield engine.queueEngine.promoteNext(session.receivingAccountId, engine.activeDurationMs);
      }
    });
  }

  /**
   * Cancel active timer for session if running.
   * @param {string} sessionId
   */
  cancelActiveTimer(sessionId) {
    const activeTimer = this.activeTimers.get(sessionId);
    if (activeTimer) {
      clearTimeout(activeTimer);
      this.activeTimers.delete(sessionId);
    }
  }

  /**
   * Customer clicked "PAYMENT DONE — CHECK MY PAYMENT".
   * 1. Cancels Timer 1 (5-minute timer).
   * 2. Starts Timer 2 (30-second processing timer).
   * 3. Customer does NOT get another 5 minutes.
   * @param {string} sessionId
   * @returns {any} Updated session in PROCESSING state
   */
  handlePaymentDone(sessionId) {
    // Commit the database transition before cancelling the active timer. A failed
    // transition leaves the session ACTIVE, so its original expiry must stay armed.
    const engine = this;
    return runMaybe(function* () {
      const session = yield engine.sessionRepo.transitionToProcessing(sessionId, engine.processingDurationMs);

      const activeTimer = engine.activeTimers.get(sessionId);
      if (activeTimer) {
        clearTimeout(activeTimer);
        engine.activeTimers.delete(sessionId);
      }

      if (engine.auditRepo) {
        yield engine.auditRepo.log({
          merchantId: session.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: sessionId,
          action: 'CUSTOMER_CLICKED_PAYMENT_DONE',
          actorType: 'CUSTOMER',
          details: { processingExpiresAt: session.processingExpiresAt?.toISOString() }
        });
      }

      engine.eventEmitter.emit('SESSION.PROCESSING', {
        sessionId,
        receivingAccountId: session.receivingAccountId,
        processingExpiresAt: session.processingExpiresAt
      });

      const delayMs = Math.max(0, session.processingExpiresAt.getTime() - Date.now());
      const procTimer = setTimeout(() => {
        Promise.resolve(engine.handleProcessingTimerExpiration(sessionId)).catch(err => {
          console.error('[TimingEngine] Processing timer expiration failed:', err.message);
        });
      }, delayMs);

      if (procTimer.unref) procTimer.unref();
      engine.processingTimers.set(sessionId, procTimer);
      return session;
    });
  }

  /**
   * Executes when Timer 2 (30-second processing window) reaches 0 with no matching observation.
   * Transitions to FAILED and promotes next queued customer.
   * @param {string} sessionId
   */
  handleProcessingTimerExpiration(sessionId) {
    this.processingTimers.delete(sessionId);
    const engine = this;
    return runMaybe(function* () {
      const session = yield engine.sessionRepo.findById(sessionId);
      if (!session || session.status !== PaymentStatus.PROCESSING) return;

      yield engine.sessionRepo.transitionToTerminal(sessionId, PaymentStatus.FAILED);
      if (engine.auditRepo) {
        yield engine.auditRepo.log({
          merchantId: session.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: sessionId,
          action: 'PAYMENT_FAILED_NO_OBSERVATION',
          actorType: 'SYSTEM',
          details: { reason: '30-second verification window elapsed with no matching observation' }
        });
      }

      engine.eventEmitter.emit('SESSION.FAILED', { sessionId, receivingAccountId: session.receivingAccountId });
      engine.eventEmitter.emit('PAYMENT.FAILED', {
        paymentId: sessionId,
        orderId: session.orderId,
        merchantId: session.merchantId,
        amountPaise: session.amountPaise
      });

      if (session.receivingAccountId) {
        yield engine.queueEngine.promoteNext(session.receivingAccountId, engine.activeDurationMs);
      }
    });
  }

  /**
   * Customer explicitly cancels the payment session during ACTIVE window.
   * Immediately releases slot and promotes next queued customer.
   * @param {string} sessionId
   */
  handleCancel(sessionId) {
    const engine = this;
    return runMaybe(function* () {
      const session = yield engine.sessionRepo.findById(sessionId);
      if (!session) return null;

      if ([PaymentStatus.PROCESSING, PaymentStatus.SUCCESS, PaymentStatus.OBSERVED_SUCCESS, PaymentStatus.RECONCILED, PaymentStatus.MANUAL_REVIEW, PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.CANCELLED].includes(session.status)) {
        return session;
      }

      engine.clearTimers(sessionId);
      const updated = yield engine.sessionRepo.transitionToTerminal(sessionId, PaymentStatus.CANCELLED);
      if (engine.auditRepo) {
        yield engine.auditRepo.log({
          merchantId: session.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: sessionId,
          action: 'PAYMENT_CANCELLED_BY_USER',
          actorType: 'CUSTOMER',
          details: { previousStatus: session.status }
        });
      }

      engine.eventEmitter.emit('SESSION.CANCELLED', { sessionId, receivingAccountId: session.receivingAccountId });
      engine.eventEmitter.emit('PAYMENT.CANCELLED', {
        paymentId: sessionId,
        orderId: session.orderId,
        merchantId: session.merchantId,
        amountPaise: session.amountPaise
      });
      if (session.receivingAccountId) {
        yield engine.queueEngine.promoteNext(session.receivingAccountId, engine.activeDurationMs);
      }

      return updated;
    });
  }

  /**
   * Clears all in-memory timer handles for a session.
   * @param {string} sessionId
   */
  clearTimers(sessionId) {
    const act = this.activeTimers.get(sessionId);
    if (act) {
      clearTimeout(act);
      this.activeTimers.delete(sessionId);
    }

    const prc = this.processingTimers.get(sessionId);
    if (prc) {
      clearTimeout(prc);
      this.processingTimers.delete(sessionId);
    }
  }

  /**
   * Clean up all timers across all sessions (for graceful shutdown).
   */
  destroy() {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.processingTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.processingTimers.clear();
  }
}
