import { NextResponse } from 'next/server';
import { fetchEventDetail } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Reject anything that is not a UUID before it reaches Postgres: a malformed
  // id would otherwise surface as a 500 from a cast error rather than a 404.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'Invalid event id' }, { status: 400 });
  }

  try {
    const event = await fetchEventDetail(id);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }
    return NextResponse.json(event, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    console.error('[api/events/:id]', error);
    return NextResponse.json({ error: 'Failed to load event' }, { status: 500 });
  }
}
