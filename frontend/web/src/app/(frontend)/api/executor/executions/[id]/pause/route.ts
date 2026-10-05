import { forwardExecutor } from '../../../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
/** POST /api/executor/executions/:id/pause (PRD §97, §128.19). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  void (await params);
  return forwardExecutor(req);
}
