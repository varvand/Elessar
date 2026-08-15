'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlertDto, EventDto, StatsDto, TimelinePointDto } from '@/lib/api-types';
import {
  STACK_ORDER,
  formatCount,
  groupForCategory,
  type CategoryGroupId,
} from '@/lib/presentation';
import { EventGlobe } from './globe/EventGlobe';
import { EventFeed } from './feed/EventFeed';
import { TimelineChart } from './charts/TimelineChart';
import { FilterBar, type FilterState } from './FilterBar';
import { StatStrip } from './StatStrip';
import { EventDetail } from './EventDetail';
import { AlertsPanel } from './AlertsPanel';
import { SourcesPanel } from './SourcesPanel';

/**
 * The dashboard.
 *
 * State lives here and flows down. Filters, the selected event and the polling
 * lifecycle are one coherent piece of state — splitting them across a store would
 * add indirection without removing any coupling, since every panel reads the same
 * filter object.
 *
 * Layout reasoning: the globe takes the largest area because spatial pattern is
 * what a globe uniquely provides. The feed sits immediately right of it in a fixed
 * column, so the same event can be read as a position and as a labelled row
 * without scrolling. The timeline spans the bottom because time is the axis both
 * of the others share.
 */

const POLL_INTERVAL_MS = 20_000;

const DEFAULT_FILTERS: FilterState = {
  groups: [...STACK_ORDER],
  minSeverity: 0,
  hours: 24,
  search: '',
  orderBy: 'hotness',
};

type RightRail = 'feed' | 'alerts' | 'sources';

export function Dashboard({
  initialEvents,
  initialStats,
  initialTimeline,
  initialAlerts,
}: {
  initialEvents: EventDto[];
  initialStats: StatsDto | null;
  initialTimeline: TimelinePointDto[];
  initialAlerts: AlertDto[];
}) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [events, setEvents] = useState<EventDto[]>(initialEvents);
  const [stats, setStats] = useState<StatsDto | null>(initialStats);
  const [timeline, setTimeline] = useState<TimelinePointDto[]>(initialTimeline);
  const [alerts, setAlerts] = useState<AlertDto[]>(initialAlerts);

  const [selected, setSelected] = useState<EventDto | null>(null);
  const [rail, setRail] = useState<RightRail>('feed');
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(new Date());
  const [refreshToken, setRefreshToken] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Debounce the search box so typing does not fire a query per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(timer);
  }, [filters.search]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.groups.length !== STACK_ORDER.length) {
      params.set('groups', filters.groups.join(','));
    }
    if (filters.minSeverity > 0) params.set('minSeverity', String(filters.minSeverity));
    params.set('hours', String(filters.hours));
    params.set('orderBy', filters.orderBy);
    params.set('limit', '600');
    if (debouncedSearch) params.set('search', debouncedSearch);
    return params.toString();
  }, [filters.groups, filters.minSeverity, filters.hours, filters.orderBy, debouncedSearch]);

  // Track the in-flight request so a slow response cannot overwrite a newer one.
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);

    try {
      const [eventsResponse, overviewResponse] = await Promise.all([
        fetch(`/api/events?${query}`, { cache: 'no-store' }),
        fetch(`/api/overview?${query}`, { cache: 'no-store' }),
      ]);

      if (requestId !== requestIdRef.current) return; // superseded

      if (!eventsResponse.ok || !overviewResponse.ok) {
        throw new Error(`HTTP ${eventsResponse.status}/${overviewResponse.status}`);
      }

      const eventsPayload = (await eventsResponse.json()) as { events: EventDto[] };
      const overviewPayload = (await overviewResponse.json()) as {
        stats: StatsDto;
        timeline: TimelinePointDto[];
        alerts: AlertDto[];
      };

      if (requestId !== requestIdRef.current) return;

      setEvents(eventsPayload.events);
      setStats(overviewPayload.stats);
      setTimeline(overviewPayload.timeline);
      setAlerts(overviewPayload.alerts);
      setLastUpdated(new Date());
      setRefreshToken((token) => token + 1);
      setConnectionError(null);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setConnectionError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [query]);

  // Refetch on filter change, then poll.
  //
  // Polling rather than SSE: the ingest worker is a separate process writing to
  // Postgres, so a push channel would need LISTEN/NOTIFY plumbing through the web
  // tier for data that changes on a 15-minute upstream cadence anyway. A 20s poll
  // is simpler, survives reconnects for free, and is never more than one cycle
  // behind the fastest source.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const event of events) {
      const group = groupForCategory(event.category);
      counts[group] = (counts[group] ?? 0) + 1;
    }
    return counts;
  }, [events]);

  const handleSelectRelated = useCallback(
    (eventId: string) => {
      const found = events.find((event) => event.id === eventId);
      if (found) {
        setSelected(found);
        return;
      }
      // Related events can fall outside the current filter window; fetch directly
      // rather than silently doing nothing when the operator clicks.
      void (async () => {
        try {
          const response = await fetch(`/api/events/${eventId}`, { cache: 'no-store' });
          if (response.ok) setSelected((await response.json()) as EventDto);
        } catch {
          /* leave the current selection in place */
        }
      })();
    },
    [events],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-plane">
      <TopBar
        stats={stats}
        loading={loading}
        lastUpdated={lastUpdated}
        connectionError={connectionError}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
        onRefresh={() => void refresh()}
      />

      <div className="border-b border-hairline bg-surface-1">
        <FilterBar value={filters} onChange={setFilters} counts={groupCounts} />
      </div>

      {/* Main: globe + right rail. `min-h-0` is required for the children's
          internal scrolling to work inside a flex column; `relative` anchors the
          detail overlay. */}
      <div className="relative flex min-h-0 flex-1">
        <main className="relative flex min-w-0 flex-1 flex-col gap-2 p-2">
          <section className="panel relative min-h-0 flex-1 overflow-hidden">
            <EventGlobe
              events={events}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              theme={theme}
              refreshToken={refreshToken}
            />
          </section>

          <section className="panel shrink-0">
            <div className="panel-header">
              <h2 className="eyebrow">Observation volume · last {formatWindow(filters.hours)}</h2>
              {/* `formatCount` instead of toLocaleString: locale-dependent
                  grouping separators differ between the server's locale and the
                  browser's, which is another hydration mismatch. */}
              <span className="eyebrow tabular">
                {formatCount(timeline.reduce((sum, point) => sum + point.total, 0))} total
              </span>
            </div>
            <div className="px-2 pb-2 pt-1.5">
              <TimelineChart
                points={timeline}
                activeGroups={filters.groups as CategoryGroupId[]}
                hours={filters.hours}
              />
            </div>
          </section>
        </main>

        {/* Right rail: tabbed, fixed width so the globe never reflows when the
            operator switches tabs. */}
        <aside className="flex w-[366px] shrink-0 flex-col border-l border-hairline bg-surface-1">
          <div className="flex items-center gap-1 border-b border-hairline px-2 py-1.5">
            {(
              [
                ['feed', 'Live feed', events.length],
                ['alerts', 'Anomalies', alerts.length],
                ['sources', 'Sources', null],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() => setRail(id)}
                aria-pressed={rail === id}
                className="btn"
                data-active={rail === id}
              >
                {label}
                {count !== null && (
                  <span className="text-ink-muted tabular">{count}</span>
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {rail === 'feed' && (
              <EventFeed
                events={events}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
                loading={loading}
              />
            )}
            {rail === 'alerts' && <AlertsPanel alerts={alerts} loading={loading} />}
            {rail === 'sources' && <SourcesPanel />}
          </div>
        </aside>

        {/* Detail panel: overlays the rail rather than adding a third column.
            A third column would shrink the globe every time the operator opened
            an event — punishing the primary interaction and reflowing the pin
            they just clicked. Overlaying keeps the globe a fixed size and leaves
            the selected pin exactly where they left it. */}
        {selected && (
          <div className="absolute inset-y-0 right-0 z-30 w-[400px] border-l border-hairline shadow-[var(--shadow-panel)]">
            <EventDetail
              event={selected}
              onClose={() => setSelected(null)}
              onSelectRelated={handleSelectRelated}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TopBar({
  stats,
  loading,
  lastUpdated,
  connectionError,
  theme,
  onToggleTheme,
  onRefresh,
}: {
  stats: StatsDto | null;
  loading: boolean;
  lastUpdated: Date | null;
  connectionError: string | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onRefresh: () => void;
}) {
  // Rendered client-side only: a server-rendered clock would mismatch on hydration.
  const [clock, setClock] = useState<string>('');
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false }) + 'Z',
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="flex shrink-0 items-center gap-4 border-b border-hairline bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2.5">
        <Wordmark />
        <div>
          <div className="text-[13px] font-semibold leading-none tracking-tight text-ink">
            Elessar
          </div>
          <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.14em] text-ink-muted">
            Situational Awareness
          </div>
        </div>
      </div>

      <span className="h-7 w-px bg-[var(--line-hairline)]" aria-hidden />

      <StatStrip stats={stats} loading={loading} />

      <div className="ml-auto flex items-center gap-3">
        {connectionError ? (
          <span
            className="flex items-center gap-1.5 text-[10.5px]"
            style={{ color: 'var(--sev-critical)' }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
            Connection error
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: loading ? 'var(--sev-elevated)' : 'var(--group-human)',
              }}
              aria-hidden
            />
            {loading ? 'Syncing' : 'Live'}
            {lastUpdated && !loading && (
              <span className="tabular">
                · {Math.max(0, Math.round((Date.now() - lastUpdated.getTime()) / 1000))}s ago
              </span>
            )}
          </span>
        )}

        <span className="mono text-[11px] text-ink-secondary">{clock}</span>

        <button type="button" onClick={onRefresh} className="btn" title="Refresh now">
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" />
            <path d="M13.5 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Refresh
        </button>

        <button
          type="button"
          onClick={onToggleTheme}
          className="btn"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
      </div>
    </header>
  );
}

/**
 * Wordmark: a palantír — concentric rings around a lit core, echoing the globe
 * and the severity rings on it.
 */
function Wordmark() {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
      <circle cx="14" cy="14" r="12.5" fill="none" stroke="var(--line-strong)" strokeWidth="1" />
      <circle cx="14" cy="14" r="8.5" fill="none" stroke="var(--group-governance)" strokeWidth="1" opacity="0.55" />
      <circle cx="14" cy="14" r="4.5" fill="var(--group-governance)" opacity="0.16" />
      <circle cx="14" cy="14" r="2" fill="var(--sev-elevated)" />
      <path d="M14 1.5v3M14 23.5v3M1.5 14h3M23.5 14h3" stroke="var(--line-strong)" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function formatWindow(hours: number): string {
  if (hours < 24) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? '24 hours' : `${days} days`;
}
