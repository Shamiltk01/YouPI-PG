import { PaymentStatus } from '@youpi/common';
import { runMaybe } from '@youpi/db';

export class QueueEngine {
  /**
   * @param {{
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   accountRepo: import('@youpi/db').ReceivingAccountRepository,
   *   eventEmitter?: { emit: (event: string, payload: any) => void },
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   activeDurationMs?: number
   * }} options
   */
  constructor(options) {
    // Payment window used whenever a caller does not pass one (PAYMENT_ACTIVE_WINDOW_MS).
    this.activeDurationMs = options.activeDurationMs || 300000;
    // Verification window for a session that reached PROCESSING (PAYMENT_PROCESSING_WINDOW_MS).
    this.processingDurationMs = options.processingDurationMs || 30000;
    this.sessionRepo = options.sessionRepo;
    this.accountRepo = options.accountRepo;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    this.auditRepo = options.auditRepo;
  }

  /**
   * Attempts to acquire an active slot or places the session into the queue.
   * @param {string} sessionId
   * @param {string} receivingAccountId
   * @param {number} [activeDurationMs] Defaults to the engine's configured payment window
   * @returns {{ status: string, queuePosition: number, expiresAt: Date | null }}
   */
  enqueueOrActivate(sessionId, receivingAccountId, activeDurationMs = this.activeDurationMs) {
    const engine = this;
    return runMaybe(function* () {
      const result = yield engine.sessionRepo.acquireSlotAtomic(sessionId, receivingAccountId, activeDurationMs);

      if (result.status === PaymentStatus.ACTIVE) {
        engine.eventEmitter.emit('SESSION.ACTIVATED', {
          sessionId,
          receivingAccountId,
          expiresAt: result.expiresAt
        });

        if (engine.auditRepo) {
          yield engine.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: sessionId,
            action: 'PAYMENT_SLOT_ACTIVATED',
            actorType: 'SYSTEM',
            details: { receivingAccountId, expiresAt: result.expiresAt?.toISOString() }
          });
        }
      } else {
        engine.eventEmitter.emit('SESSION.QUEUED', {
          sessionId,
          receivingAccountId,
          queuePosition: result.queuePosition
        });

        if (engine.auditRepo) {
          yield engine.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: sessionId,
            action: 'PAYMENT_ENQUEUED',
            actorType: 'SYSTEM',
            details: { receivingAccountId, queuePosition: result.queuePosition }
          });
        }
      }

      return result;
    });
  }

  /**
   * Promotes the next queued session for a receiving account if the slot is free.
   * @param {string} receivingAccountId
   * @param {number} [activeDurationMs] Defaults to the engine's configured payment window
   * @returns {any | null} The newly activated session or null if queue is empty or slot is busy
   */
  promoteNext(receivingAccountId, activeDurationMs = this.activeDurationMs) {
    const engine = this;
    return runMaybe(function* () {
      const active = yield engine.sessionRepo.findCurrentActiveOrProcessing(receivingAccountId);
      if (active) return null;

      const nextQueued = yield engine.sessionRepo.getNextQueuedSession(receivingAccountId);
      if (!nextQueued) return null;

      const res = yield engine.sessionRepo.acquireSlotAtomic(nextQueued.id, receivingAccountId, activeDurationMs);
      if (res.status !== PaymentStatus.ACTIVE) return null;

      yield engine.sessionRepo.reindexQueue(receivingAccountId);
      const activatedSession = yield engine.sessionRepo.findById(nextQueued.id);

      engine.eventEmitter.emit('SESSION.ACTIVATED', {
        sessionId: nextQueued.id,
        receivingAccountId,
        expiresAt: activatedSession.expiresAt
      });
      engine.eventEmitter.emit('QUEUE.PROMOTED', {
        receivingAccountId,
        promotedSessionId: nextQueued.id
      });

      if (engine.auditRepo) {
        yield engine.auditRepo.log({
          merchantId: activatedSession.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: nextQueued.id,
          action: 'QUEUE_PROMOTION_TO_ACTIVE',
          actorType: 'SYSTEM',
          details: { receivingAccountId, expiresAt: activatedSession.expiresAt?.toISOString() }
        });
      }

      return activatedSession;
    });
  }

  /**
   * Calculates estimated wait time in seconds for a queued session.
   * @param {string} receivingAccountId
   * @param {number} queuePosition
   * @returns {number} Estimated seconds until activation
   */
  calculateEstimatedWaitSeconds(receivingAccountId, queuePosition) {
    if (queuePosition <= 0) return 0;
    const engine = this;
    return runMaybe(function* () {
      let currentSlotRemaining = 0;
      const currentActive = yield engine.sessionRepo.findCurrentActiveOrProcessing(receivingAccountId);

      if (currentActive) {
        const now = Date.now();
        if (currentActive.status === PaymentStatus.PROCESSING && currentActive.processingExpiresAt) {
          currentSlotRemaining = Math.max(0, Math.ceil((currentActive.processingExpiresAt.getTime() - now) / 1000));
        } else if (currentActive.status === PaymentStatus.ACTIVE && currentActive.expiresAt) {
          currentSlotRemaining = Math.max(0, Math.ceil((currentActive.expiresAt.getTime() - now) / 1000));
        }
      }

      const cycleDurationSeconds = Math.round((engine.activeDurationMs + engine.processingDurationMs) / 1000);
      const precedingQueuedWait = (queuePosition - 1) * cycleDurationSeconds;
      return currentSlotRemaining + precedingQueuedWait;
    });
  }
}
