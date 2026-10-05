import { forwardExecutor } from '../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/**
 * POST /api/executor/emergency — Emergency Stop (PRD §75): stop all managed
 * strategies and cancel managed open orders. Positions are NEVER closed here;
 * that stays a separate explicit action.
 */
export async function POST(req: Request) {
  return forwardExecutor(req);
}
