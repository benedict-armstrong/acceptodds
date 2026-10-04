'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Deck, LinearInterpolator, OrthographicView, type OrthographicViewState } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import {
  CollisionFilterExtension,
  DataFilterExtension,
  type CollisionFilterExtensionProps,
  type DataFilterExtensionProps,
} from '@deck.gl/extensions';
import { dotScale, MAP_SIZE, sparseScale, type TopicLabel } from '@/lib/map';

export type LabelMode = 'auto' | 'region' | 'cluster' | 'off';

/** Below this zoom (past the opening view) `auto` labels regions, above it clusters. */
const CLUSTER_LABELS_FROM = 1;
const ACCENT: [number, number, number] = [179, 27, 27];
const INK: [number, number, number, number] = [29, 29, 29, 230];
const PAGE: [number, number, number, number] = [251, 250, 247, 230];
const FILTER = new DataFilterExtension({ filterSize: 1 });

/**
 * The map itself, in WebGL (deck.gl). Client-only: `PaperMapView` loads it
 * with `ssr: false`. Draws what it is given and reports hovers and clicks;
 * it fetches nothing and knows nothing about papers.
 */
export default function MapCanvas({
  positions,
  colours,
  shown,
  starred,
  held,
  regions,
  clusters,
  labelMode,
  selected,
  neighbours,
  focus,
  onHover,
  onSelect,
}: {
  /** Interleaved x, y in `[0, MAP_SIZE]` (`lib/map.ts` `normalise`). */
  positions: Float32Array;
  /** RGBA per point. */
  colours: Uint8Array;
  /** 1 per point drawn, 0 per point hidden (neither drawn nor pickable); `null` draws every point. */
  shown: Float32Array | null;
  /** The viewer's starred papers, drawn as a star; held ones, ringed. Indexes into the points. */
  starred: number[];
  held: number[];
  regions: TopicLabel[];
  clusters: TopicLabel[];
  labelMode: LabelMode;
  selected: number | null;
  neighbours: number[];
  /** Fly to a point; a new object each time, so the same point can be flown to twice. */
  focus: { index: number } | null;
  onHover: (hover: { index: number; x: number; y: number } | null) => void;
  onSelect: (index: number | null) => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const deck = useRef<Deck<OrthographicView> | null>(null);
  const opening = useRef(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const everyPoint = useMemo(() => new Float32Array(positions.length / 2).fill(1), [positions]);
  const handlers = useRef({ onHover, onSelect });
  useEffect(() => {
    handlers.current = { onHover, onSelect };
  });

  useEffect(() => {
    const el = parent.current!;
    opening.current = Math.log2((Math.min(el.clientWidth, el.clientHeight) / MAP_SIZE) * 0.95);
    const initialViewState: OrthographicViewState = {
      target: [MAP_SIZE / 2, MAP_SIZE / 2, 0],
      zoom: opening.current,
      minZoom: opening.current - 1,
      maxZoom: opening.current + 9,
    };
    deck.current = new Deck({
      parent: el,
      views: new OrthographicView({ flipY: false }),
      initialViewState,
      controller: { doubleClickZoom: true, inertia: true },
      getCursor: ({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
      onViewStateChange: ({ viewState }) => setZoom((viewState as OrthographicViewState).zoom as number),
      onClick: (info) => {
        if (!info.picked) handlers.current.onSelect(null);
      },
    });
    setZoom(opening.current);
    return () => {
      deck.current?.finalize();
      deck.current = null;
      // finalize() leaves the canvas it made in `parent`; a remount (Strict Mode's, in dev) would stack below it.
      el.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (!focus || !deck.current) return;
    const i = focus.index;
    deck.current.setProps({
      initialViewState: {
        target: [positions[2 * i], positions[2 * i + 1], 0],
        zoom: Math.max(zoom ?? opening.current, opening.current + 3),
        minZoom: opening.current - 1,
        maxZoom: opening.current + 9,
        transitionDuration: 600,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
      },
    });
    // Only a new focus flies; zoom changes must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, positions]);

  useEffect(() => {
    if (!deck.current || zoom === null) return;
    const n = positions.length / 2;
    const shownCount = shown ? shown.reduce((a, v) => a + v, 0) : n;
    // Zoom and sparseness both grow the dots; together never past 8x, or zoomed-in sparse dots swamp the map.
    const scale = Math.min(8, dotScale(zoom, opening.current) * sparseScale(shownCount, n));
    const dimmed = selected !== null;
    const level =
      labelMode === 'auto' ? (zoom - opening.current < CLUSTER_LABELS_FROM ? 'region' : 'cluster') : labelMode;
    const labels = level === 'region' ? regions : level === 'cluster' ? clusters : [];
    const at = (i: number): [number, number] => [positions[2 * i], positions[2 * i + 1]];
    // Only what the map shows: a search that hides the rest hides the viewer's papers too.
    const visible = (indexes: number[]) => (shown ? indexes.filter((i) => shown[i] > 0) : indexes);
    const layers = [
      new ScatterplotLayer<unknown, DataFilterExtensionProps>({
        id: 'papers',
        data: {
          length: n,
          attributes: {
            getPosition: { value: positions, size: 2 },
            getFillColor: { value: colours, size: 4 },
            getFilterValue: { value: shown ?? everyPoint, size: 1 },
          },
        },
        // Always on the layer, so turning the filter on and off never rebuilds it.
        extensions: [FILTER],
        filterEnabled: shown !== null,
        filterRange: [0.5, 1],
        radiusUnits: 'pixels',
        getRadius: 1.6,
        radiusScale: scale,
        radiusMinPixels: 1,
        opacity: dimmed ? 0.2 : 1,
        pickable: true,
        onHover: ({ index, x, y }) => handlers.current.onHover(index >= 0 ? { index, x, y } : null),
        onClick: ({ index }) => handlers.current.onSelect(index),
      }),
      held.length > 0 &&
        new ScatterplotLayer<number>({
          id: 'held',
          data: visible(held),
          getPosition: (j) => at(j),
          filled: false,
          stroked: true,
          getLineColor: [...ACCENT, 230],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          radiusUnits: 'pixels',
          getRadius: 1.6 * scale + 3,
          updateTriggers: { getPosition: positions, getRadius: scale },
        }),
      starred.length > 0 &&
        new TextLayer<number>({
          id: 'starred',
          data: visible(starred),
          getPosition: (j) => at(j),
          getText: () => '★',
          characterSet: ['★'],
          getSize: 9 + 2.5 * scale,
          getColor: (j) => [colours[4 * j], colours[4 * j + 1], colours[4 * j + 2], 255],
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSettings: { sdf: true },
          outlineWidth: 3,
          outlineColor: PAGE,
          updateTriggers: { getPosition: positions, getColor: colours, getSize: scale },
        }),
      selected !== null &&
        new LineLayer<number>({
          id: 'neighbour-lines',
          data: neighbours,
          getSourcePosition: () => at(selected),
          getTargetPosition: (j) => at(j),
          getColor: [...ACCENT, 140],
          getWidth: 1.2,
        }),
      selected !== null &&
        new ScatterplotLayer<number>({
          id: 'selection',
          data: [...neighbours, selected],
          getPosition: (j) => at(j),
          getFillColor: (j) =>
            j === selected ? [...ACCENT, 255] : [colours[4 * j], colours[4 * j + 1], colours[4 * j + 2], 255],
          getLineColor: [255, 255, 255, 255],
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1,
          radiusUnits: 'pixels',
          getRadius: (j) => (j === selected ? 5 : 3.5),
          radiusScale: Math.sqrt(scale),
          pickable: true,
          onHover: ({ object, x, y }) =>
            handlers.current.onHover(object !== undefined ? { index: object, x, y } : null),
          onClick: ({ object }) => handlers.current.onSelect(object ?? null),
          updateTriggers: { getFillColor: [selected, colours], getRadius: selected },
        }),
      labels.length > 0 &&
        new TextLayer<TopicLabel, CollisionFilterExtensionProps<TopicLabel>>({
          id: `labels-${level}`,
          data: labels,
          getPosition: (d) => [d.x, d.y],
          getText: (d) => d.text,
          getSize: level === 'region' ? 13 : 11,
          getColor: INK,
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontSettings: { sdf: true },
          outlineWidth: 4,
          outlineColor: PAGE,
          characterSet: 'auto',
          extensions: [new CollisionFilterExtension()],
          getCollisionPriority: (d) => d.size,
        }),
    ];
    deck.current.setProps({ layers });
  }, [positions, colours, shown, everyPoint, starred, held, regions, clusters, labelMode, selected, neighbours, zoom]);

  return <div ref={parent} className="relative h-full w-full" />;
}
