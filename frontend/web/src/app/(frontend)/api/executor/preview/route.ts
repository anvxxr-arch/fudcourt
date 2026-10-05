import { forwardExecutor } from '../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/**
 * POST /api/executor/preview — dry run only (PRD §98): nothing is created and
 * no external order is ever placed on this path.
 */
export async function POST(req: Request) {
  return forwardExecutor(req);
}
