import { NextResponse } from 'next/server';
import { fetchEvents, parseFilters } from '@/lib/server/queries';

/**
 * Event list — the endpoint the globe and the feed both read.
 *
 * Dynamic (never statically cached): a situational-awareness view serving a
 * cached snapshot is worse than one that is slow, because the operator has no
 * way to tell the difference.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const filters = parseFilters(new URL(request.url));

  try {
    const events = await fetchEvents(filters);
    return NextResponse.json(
      { events, filters, generatedAt: new Date().toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('[api/events]', error);
    return NextResponse.json({ error: 'Failed to load events' }, { status: 500 });
  }
}
