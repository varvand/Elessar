import { NextResponse } from 'next/server';
import { fetchGraph } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const hours = Number.parseInt(new URL(request.url).searchParams.get('hours') ?? '24', 10);
  const window = Number.isFinite(hours) ? Math.min(720, Math.max(1, hours)) : 24;

  try {
    const graph = await fetchGraph(window);
    return NextResponse.json(graph, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[api/graph]', error);
    return NextResponse.json({ error: 'Failed to load graph' }, { status: 500 });
  }
}
