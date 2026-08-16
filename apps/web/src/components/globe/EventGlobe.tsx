'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { MeshPhongMaterial } from 'three';
import * as topojson from 'topojson-client';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { EventDto } from '@/lib/api-types';
import { SEVERITY_HEX_DARK, SEVERITY_HEX_LIGHT, severityBand } from '@/lib/presentation';

/**
 * The event globe.
 *
 * Rendering choices and why:
 *
 * - **Vector country polygons, not a satellite texture.** A photographic Earth
 *   fights the data for attention and needs megabytes of external imagery. Flat
 *   dark landmasses with hairline borders keep the pins as the brightest thing on
 *   screen, load from a 100 kB bundled TopoJSON, and need no network at runtime.
 *
 * - **Colour encodes severity, size encodes severity.** Deliberately redundant.
 *   A globe is a scatter plot, where every pin can sit beside any other, and no
 *   palette gives 5+ hues that survive all-pairs colourblind separation. Encoding
 *   the taxonomy in hue would therefore be unreadable; encoding severity twice is
 *   robust for every viewer. Category identity lives in the tooltip and the feed,
 *   where a text label carries it unambiguously.
 *
 * - **Rings only on critical events.** Motion is the strongest pre-attentive cue
 *   there is, so it is spent on the single thing that must not be missed. Ringing
 *   everything would spend it on nothing.
 */

// react-globe.gl reaches for `window` at module scope, so it cannot be imported
// during SSR. The skeleton below is what the operator sees while it loads.
const Globe = dynamic(() => import('react-globe.gl'), {
  ssr: false,
  loading: () => <GlobeSkeleton />,
});

interface EventGlobeProps {
  events: EventDto[];
  selectedId: string | null;
  onSelect: (event: EventDto) => void;
  theme: 'dark' | 'light';
  /** Signals a completed refresh, so the globe can flash newly arrived pins. */
  refreshToken?: number;
}

interface PointDatum {
  id: string;
  lat: number;
  lng: number;
  size: number;
  color: string;
  severity: number;
  event: EventDto;
}

const GLOBE_COLORS = {
  dark: {
    background: '#080d14',
    ocean: '#0b111a',
    land: '#1b2534',
    landStroke: '#33415a',
    atmosphere: '#3987e5',
  },
  light: {
    background: '#edf2f7',
    ocean: '#dde5ef',
    land: '#ffffff',
    landStroke: '#aab6c6',
    atmosphere: '#2a78d6',
  },
} as const;

export function EventGlobe({
  events,
  selectedId,
  onSelect,
  theme,
  refreshToken = 0,
}: EventGlobeProps) {
  const globeRef = useRef<GlobeInstance | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [countries, setCountries] = useState<Feature<Geometry>[]>([]);
  const [hovered, setHovered] = useState<PointDatum | null>(null);

  const palette = GLOBE_COLORS[theme];
  const severityHex = theme === 'dark' ? SEVERITY_HEX_DARK : SEVERITY_HEX_LIGHT;
  const globeMaterial = useMemo(
    () =>
      new MeshPhongMaterial({
        color: palette.ocean,
        emissive: palette.ocean,
        emissiveIntensity: 0.08,
        shininess: 0.1,
        transparent: false,
        opacity: 1,
      }),
    [palette.ocean],
  );

  useEffect(() => () => globeMaterial.dispose(), [globeMaterial]);

  // --- Country outlines -----------------------------------------------------
  // Loaded from the bundled world-atlas TopoJSON and converted once. 110m
  // resolution is the right tradeoff: recognizable coastlines at ~100 kB, versus
  // ~700 kB for 50m detail no one can see on a rotating sphere.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const world = (await import('world-atlas/countries-110m.json')).default as unknown;
        const collection = topojson.feature(
          world as Parameters<typeof topojson.feature>[0],
          (world as { objects: { countries: unknown } }).objects.countries as Parameters<
            typeof topojson.feature
          >[1],
        ) as unknown as FeatureCollection<Geometry>;
        if (!cancelled) setCountries(collection.features);
      } catch (error) {
        // A globe without borders is degraded but still usable — the pins are
        // the data. Failing soft beats an empty panel.
        console.error('Failed to load country outlines', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Responsive sizing ----------------------------------------------------
  // The canvas needs explicit pixel dimensions, so the container is measured
  // rather than styled with percentages.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // --- Points ---------------------------------------------------------------
  const points = useMemo<PointDatum[]>(() => {
    return (
      events
        .filter((event) => event.lat !== null && event.lon !== null)
        .map((event) => {
          const band = severityBand(event.severity);
          return {
            id: event.id,
            lat: event.lat as number,
            lng: event.lon as number,
            // Square-rooted so area, not radius, tracks severity — radius scaling
            // exaggerates large values roughly quadratically to the eye.
            size: 0.16 + Math.sqrt(event.severity / 100) * 0.62,
            color: severityHex[band],
            severity: event.severity,
            event,
          };
        })
        // Paint low severity first so critical pins are never buried by routine
        // ones at the same location.
        .sort((a, b) => a.severity - b.severity)
    );
  }, [events, severityHex]);

  const criticalRings = useMemo(
    () =>
      points
        .filter((point) => point.severity >= 70)
        .map((point) => ({
          lat: point.lat,
          lng: point.lng,
          maxR: 4.5,
          propagationSpeed: 1.1,
          repeatPeriod: 1400,
          color: point.color,
        })),
    [points],
  );

  // --- Initial camera framing ----------------------------------------------
  // react-globe.gl defaults to altitude 2.5, which leaves the sphere small in a
  // large panel. 1.75 fills the viewport while keeping a full hemisphere in
  // frame, which is what makes a globe worth using over a flat map.
  const framedRef = useRef(false);
  useEffect(() => {
    if (framedRef.current || size.width === 0) return;
    const globe = globeRef.current;
    if (!globe) return;
    framedRef.current = true;
    // Opens on Europe/Africa/Middle East — the densest region for these sources.
    globe.pointOfView({ lat: 22, lng: 18, altitude: 1.75 }, 0);
  }, [size.width]);

  // --- Auto-rotation, paused on interaction --------------------------------
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;

    const controls = globe.controls();
    controls.autoRotate = !selectedId && !hovered;
    controls.autoRotateSpeed = 0.22;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // Stop the camera from tunnelling through the surface or drifting to infinity.
    controls.minDistance = 130;
    controls.maxDistance = 620;
  }, [selectedId, hovered, size.width]);

  // Fly to a selected event so the feed and the globe stay in agreement.
  useEffect(() => {
    if (!selectedId) return;
    const target = points.find((point) => point.id === selectedId);
    const globe = globeRef.current;
    if (!target || !globe) return;
    globe.pointOfView({ lat: target.lat, lng: target.lng, altitude: 1.5 }, 900);
  }, [selectedId, points]);

  const handleClick = useCallback(
    (datum: object) => {
      onSelect((datum as PointDatum).event);
    },
    [onSelect],
  );

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {size.width > 0 && (
        <Globe
          ref={globeRef as never}
          width={size.width}
          height={size.height}
          backgroundColor={palette.background}
          // A flat colour rather than an image: no external asset, and the ocean
          // stays darker than any pin.
          globeImageUrl={undefined as unknown as string}
          showGlobe
          showGraticules
          showAtmosphere
          atmosphereColor={palette.atmosphere}
          atmosphereAltitude={0.14}
          globeMaterial={globeMaterial}
          polygonsData={countries}
          polygonCapColor={() => palette.land}
          polygonSideColor={() => 'rgba(0,0,0,0)'}
          polygonStrokeColor={() => palette.landStroke}
          polygonAltitude={0.006}
          pointsData={points}
          pointLat="lat"
          pointLng="lng"
          pointColor="color"
          pointAltitude={0.012}
          pointRadius="size"
          pointsMerge={false}
          pointsTransitionDuration={400}
          onPointClick={handleClick}
          onPointHover={(datum) => setHovered((datum as PointDatum | null) ?? null)}
          ringsData={criticalRings}
          ringColor={(ring: object) => () => (ring as { color: string }).color}
          ringMaxRadius="maxR"
          ringPropagationSpeed="propagationSpeed"
          ringRepeatPeriod="repeatPeriod"
          animateIn={false}
        />
      )}

      {hovered && <GlobeTooltip point={hovered} />}

      <GlobeLegend theme={theme} shifted={selectedId !== null} />

      {/* Pin count, so an empty globe is legibly "no matching events" rather
          than looking like a failed load. */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10">
        <span className="eyebrow tabular">
          {points.length} located {points.length === 1 ? 'event' : 'events'}
          {events.length > points.length && (
            <span className="text-ink-muted"> · {events.length - points.length} unlocated</span>
          )}
        </span>
      </div>

      {/* Refresh tick, doubles as a liveness indicator. */}
      <span key={refreshToken} className="sr-only" aria-live="polite">
        Globe updated with {points.length} located events
      </span>
    </div>
  );
}

function GlobeTooltip({ point }: { point: PointDatum }) {
  const band = severityBand(point.severity);
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-20 w-[min(24rem,90%)] -translate-x-1/2">
      <div
        className="panel px-3 py-2 shadow-[var(--shadow-panel)]"
        style={{ background: 'color-mix(in oklab, var(--surface-1) 92%, transparent)' }}
      >
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: point.color }}
            aria-hidden
          />
          {/* Label, never colour alone. */}
          <span className="eyebrow" style={{ color: point.color }}>
            {band}
          </span>
          <span className="eyebrow text-ink-muted tabular">{point.severity}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-ink">{point.event.title}</p>
        {point.event.placeName && (
          <p className="mt-0.5 truncate text-[11px] text-ink-muted">{point.event.placeName}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Severity legend.
 *
 * Always present, because severity is encoded in colour and an unlabelled colour
 * scale is not an encoding — it is decoration.
 */
function GlobeLegend({ theme, shifted }: { theme: 'dark' | 'light'; shifted: boolean }) {
  const hex = theme === 'dark' ? SEVERITY_HEX_DARK : SEVERITY_HEX_LIGHT;
  const bands: { band: keyof typeof hex; label: string; range: string }[] = [
    { band: 'critical', label: 'Critical', range: '70+' },
    { band: 'serious', label: 'Serious', range: '50–69' },
    { band: 'elevated', label: 'Elevated', range: '30–49' },
    { band: 'routine', label: 'Routine', range: '<30' },
  ];

  return (
    <div
      className={`pointer-events-none absolute top-3 z-10 transition-[right] duration-300 ease-out ${
        shifted ? 'right-14' : 'right-3'
      }`}
    >
      <div className="flex flex-col gap-1.5 rounded-md border border-hairline bg-[color-mix(in_oklab,var(--surface-1)_86%,transparent)] px-2.5 py-2">
        <span className="eyebrow">Severity</span>
        {bands.map(({ band, label, range }) => (
          <div key={band} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: hex[band] }} aria-hidden />
            <span className="text-[10.5px] text-ink-secondary">{label}</span>
            <span className="ml-auto text-[10px] text-ink-muted tabular">{range}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GlobeSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="relative">
        <div className="h-56 w-56 rounded-full border border-hairline bg-surface-2" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="eyebrow">Initialising globe…</span>
        </div>
      </div>
    </div>
  );
}

/** Minimal shape of the imperative handle react-globe.gl exposes. */
interface GlobeInstance {
  controls(): {
    autoRotate: boolean;
    autoRotateSpeed: number;
    enableDamping: boolean;
    dampingFactor: number;
    minDistance: number;
    maxDistance: number;
  };
  pointOfView(view: { lat: number; lng: number; altitude: number }, durationMs?: number): void;
}
