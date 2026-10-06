import { NextResponse } from 'next/server';
import { getAll } from '@/server/db';
import { failInternal } from '../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const data = await getAll();
    return NextResponse.json(data);
  } catch (e: unknown) {
    return failInternal(e);
  }
}