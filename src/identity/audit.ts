import type { Tx } from '../database/prisma-errors';

export type AuditKind =
  | 'ADMIN_GRANTED'
  | 'ADMIN_REVOKED'
  | 'INVITATION_CREATED'
  | 'INVITATION_REDEEMED'
  | 'USER_SUSPENDED'
  | 'USER_REACTIVATED'
  | 'DESTINATION_BLOCKED'
  | 'DESTINATION_RESTORED'
  | 'LIMIT_CHANGED'
  | 'INVITATION_REVOKED';

/** Identifiers, codes and counts only; never tokens, prompts or report content. */
export type AuditDetails = Record<string, string | number | boolean | null>;

/** Appends one audit event inside the business transaction. */
export async function recordAudit(
  tx: Tx,
  event: {
    kind: AuditKind;
    actorUserId?: string | null;
    subjectUserId?: string | null;
    invitationId?: string | null;
    details?: AuditDetails;
  },
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      kind: event.kind,
      actorUserId: event.actorUserId ?? null,
      subjectUserId: event.subjectUserId ?? null,
      invitationId: event.invitationId ?? null,
      details: event.details ?? {},
    },
  });
}
