import { forwardExecutor } from '../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** GET /api/executor/executions?status= — the session user's execution history (PRD §97, §128.22). */
export async function GET(req: Request) {
  return forwardExecutor(req);
}
/** POST /api/executor/executions — create with an immutable input snapshot (PRD §99). */
export async function POST(req: Request) {
  return forwardExecutor(req);
}
