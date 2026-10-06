import { Badge } from '@/ui/badge';

const GOOD: Record<string, true> = { ACTIVE: true, FILLED: true, READY: true, RUNNING: true, VALIDATED: true };
const BAD: Record<string, true> = { INVALID: true, EXPIRED: true, REVOKED: true, PERMISSION_ERROR: true, REJECTED: true, FAILED: true, RISK_STOPPED: true };

/**
 * A status badge: colour carries meaning, the text always carries it too.
 * Good states render as the accent (blue) badge, bad states as negative (red),
 * anything else as the neutral badge. The classification is the executor's;
 * the rendering is the one Badge atom every family now shares.
 */
export function StatusPill({ status }: { status: string }) {
  const variant = status in GOOD ? 'accent' : status in BAD ? 'negative' : 'neutral';
  return <Badge variant={variant} size="sm">{status}</Badge>;
}
