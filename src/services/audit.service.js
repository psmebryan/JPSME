const prisma = require('../config/prisma');

// General-purpose audit trail (distinct from ChapterAdminAudit, which only
// covers chapter-admin reassignment). Never pass secrets/credentials in
// metadata — only plain values (amounts, IDs, reasons).
async function log({ action, actorId = null, targetUserId = null, paymentId = null, metadata = null, ipAddress = null }) {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        actorId: actorId ? Number(actorId) : null,
        targetUserId: targetUserId ? Number(targetUserId) : null,
        paymentId: paymentId ? Number(paymentId) : null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        ipAddress: ipAddress || null,
      },
    });
  } catch (err) {
    // Auditing must never break the underlying operation it's observing.
    console.error('Failed to write audit log:', action, err.message);
  }
}

const PAGE_SIZE = 25;

// Every distinct value AuditAction can take — kept here (not just in the
// Prisma schema) so the admin UI's filter dropdown and the query validator
// have one place to read the list from, instead of hand-copying it a third
// time and letting it drift.
const AUDIT_ACTIONS = [
  'PAYMENT_CREATED',
  'PAYMENT_PROCESSING', // reserved: Payment.status never actually transitions to PROCESSING today (PENDING goes straight to PAID/FAILED/EXPIRED) — kept for a future intermediate state, not currently logged
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'WEBHOOK_RECEIVED',
  'WEBHOOK_REJECTED',
  'WEBHOOK_DUPLICATE',
  'REFUND_REQUESTED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'UNAUTHORIZED_PAYMENT_ACCESS',
  'SUSPICIOUS_PAYMENT_MISMATCH',
  'PAYMENT_RECONCILED',
  'USER_STATUS_CHANGED',
];

const SAFE_USER_SELECT = { id: true, firstName: true, lastName: true, email: true };

// MAIN_ADMIN-only read (enforced at the route layer, not here) — powers the
// admin audit-log page. `actor: 'system'` filters to actions with no human
// actor (actorId null), e.g. the payment-confirmed auto-approval.
async function listAuditLogs({ action, actor, targetUserId, paymentId, dateFrom, dateTo, page = 1 } = {}) {
  const where = {};
  if (action) where.action = action;
  if (actor === 'system') where.actorId = null;
  else if (actor) where.actorId = Number(actor);
  if (targetUserId) where.targetUserId = Number(targetUserId);
  if (paymentId) where.paymentId = Number(paymentId);
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(`${dateTo}T23:59:59.999`);
  }

  const safePage = Math.max(1, Number(page) || 1);

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: {
        actor: { select: SAFE_USER_SELECT },
        targetUser: { select: SAFE_USER_SELECT },
      },
      orderBy: { createdAt: 'desc' },
      skip: (safePage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return { logs, total, page: safePage, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

module.exports = { log, listAuditLogs, AUDIT_ACTIONS };
