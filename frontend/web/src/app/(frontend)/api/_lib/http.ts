import { NextResponse } from 'next/server';

export function fail(message: string, status: number, detail?: string) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}
