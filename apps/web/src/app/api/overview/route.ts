import { NextResponse } from 'next/server';
import { fetchAlerts, fetchStats, fetchTimeline, parseFilters } from '@/lib/server/queries';

/**
 * Everything the dashboard chrome needs — stats, timeline, alerts — in one
 * round trip.
 *
 * Bundled deliberately. These three always refresh together, and three separate
 * polls would triple the request count while allowing the panels to disagree
 * with each other by a few seconds, which looks like a bug to an operator.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const filters = parseFilters(new URL(request.url));

  try {
    const [stats, timeline, alerts] = await Promise.all([
      fetchStats(),
      fetchTimeline(filters.hours, filters.groups),
      fetchAlerts(30),
    ]);

    return NextResponse.json(
      { stats, timeline, alerts, generatedAt: new Date().toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    console.error('[api/overview]', error);
    return NextResponse.json({ error: 'Failed to load overview' }, { status: 500 });
  }
}
