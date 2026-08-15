import { NextResponse } from 'next/server';
import { fetchSourceHealth } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sources = await fetchSourceHealth();
    return NextResponse.json({ sources }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[api/sources]', error);
    return NextResponse.json({ error: 'Failed to load sources' }, { status: 500 });
  }
}
