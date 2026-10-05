import { forwardExecutor } from '../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** GET /api/executor/accounts — the session user's connected exchange accounts (PRD §97). */
export async function GET(req: Request) {
  return forwardExecutor(req);
}
/** POST /api/executor/accounts — BYOK connect (PRD §43-46). Secrets are sealed server-side and never returned. */
export async function POST(req: Request) {
  return forwardExecutor(req);
}
