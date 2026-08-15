import { Dashboard } from '@/components/Dashboard';
import { fetchAlerts, fetchEvents, fetchStats, fetchTimeline } from '@/lib/server/queries';
import { STACK_ORDER } from '@/lib/presentation';
import type { AlertDto, EventDto, StatsDto, TimelinePointDto } from '@/lib/api-types';

/**
 * Dashboard entry point.
 *
 * The first screenful is server-rendered so the operator sees real data on load
 * rather than a spinner that resolves into a globe. The client then takes over
 * polling. `force-dynamic` because any cached render of this page is, by
 * definition, stale situational awareness.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const defaults = {
    groups: [...STACK_ORDER],
    minSeverity: 0,
    hours: 24,
    search: null,
    limit: 600,
    locatedOnly: false,
    orderBy: 'hotness' as const,
  };

  // Degrade to an empty dashboard rather than an error page: the client will
  // retry within seconds, and a visible shell with a warning is far more useful
  // to an operator than a stack trace. This is also the first-run path, before
  // the ingest worker has written anything.
  let events: EventDto[] = [];
  let stats: StatsDto | null = null;
  let timeline: TimelinePointDto[] = [];
  let alerts: AlertDto[] = [];

  try {
    [events, stats, timeline, alerts] = await Promise.all([
      fetchEvents(defaults),
      fetchStats(),
      fetchTimeline(defaults.hours, defaults.groups),
      fetchAlerts(30),
    ]);
  } catch (error) {
    console.error('[page] initial load failed', error);
  }

  return (
    <Dashboard
      initialEvents={events}
      initialStats={stats}
      initialTimeline={timeline}
      initialAlerts={alerts}
    />
  );
}
