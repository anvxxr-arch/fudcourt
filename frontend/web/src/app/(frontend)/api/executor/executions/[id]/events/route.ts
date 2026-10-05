import { forwardExecutor } from '../../../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** GET /api/executor/executions/:id/events — immutable event log (PRD §63, §97). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  void (await params);
  return forwardExecutor(req);
}
