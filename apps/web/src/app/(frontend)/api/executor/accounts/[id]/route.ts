import { forwardExecutor } from '../../_proxy';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
type Params = { params: Promise<{ id: string }> };
/** GET /api/executor/accounts/:id — one account, masked key only (PRD §87, §109). */
export async function GET(req: Request, { params }: Params) {
  void (await params);
  return forwardExecutor(req);
}
/** DELETE /api/executor/accounts/:id — revocation, never a plaintext round trip (PRD §87). */
export async function DELETE(req: Request, { params }: Params) {
  void (await params);
  return forwardExecutor(req);
}
