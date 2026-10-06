import { forwardExecutor } from '../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** GET /api/executor/settings — the user's risk profile (PRD §88, §119). */
export async function GET(req: Request) {
  return forwardExecutor(req);
}
/** PUT /api/executor/settings — risk profile update (PRD §88). */
export async function PUT(req: Request) {
  return forwardExecutor(req);
}
