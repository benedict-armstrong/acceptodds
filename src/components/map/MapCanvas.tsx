'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Deck,
  LinearInterpolator,
  OrthographicController,
  OrthographicView,
  type OrthographicViewState,
} from '@deck.gl/core';
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
/**
 * The labels' SDF atlas. deck's `outlineWidth` is a fraction of the glyph's
 * distance field (0–1), and the halo can reach no further than `buffer`: the
 * field is wide enough here (`radius`) for a ~2.5px halo at label sizes, with
 * a soft edge (`smoothing`) under half a pixel.
 */
const LABEL_FONT = { sdf: true, fontSize: 96, buffer: 32, radius: 48, smoothing: 0.2 };
const LABEL_HALO = 0.2;
/** How far the view may drift from where it opened before "Reset view" shows: a fraction of a pixel. */
const HOME_TOLERANCE = 0.5;
const FILTER = new DataFilterExtension({ filterSize: 1 });
const SAFARI_GESTURES = ['gesturestart', 'gesturechange', 'gestureend'];

/**
 * deck's controller, except that a drag always pans. Its own turns a drag
 * with ⌘, Ctrl, Alt or Shift held into a rotation, which a flat
 * (orthographic) view cannot do, so the drag did nothing — and the minimap
 * zooms with ⌘ held, so a drag straight after a zoom would be lost.
 */
class PanController extends OrthographicController {
  isFunctionKeyPressed(event: Parameters<OrthographicController['isFunctionKeyPressed']>[0]): boolean {
    return event.type === 'panstart' ? false : super.isFunctionKeyPressed(event);
  }
}

/**
 * Embedded in a page that scrolls, on a touch screen one finger scrolls the
 * page and two pan and zoom, as an embedded Google map does: the browser
 * keeps one-finger pans (`touch-action: pan-x pan-y`, below), and a pinch
 * pans as it zooms, around the fingers. Without this the figure caught every
 * swipe and the page could not be scrolled past it.
 */
class EmbeddedController extends PanController {
  protected _onPanStart(event: Parameters<PanController['_onPanStart']>[0]): boolean {
    return event.pointerType === 'touch' ? false : super._onPanStart(event);
  }
}

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
  onOpen,
  dotRadius = 1.6,
  dimmed: dimmedOpacity = 0.2,
  embedded = false,
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
  /** A paper clicked with ⌘ or Ctrl held, as a link would open in a new tab; without it, such a click selects. */
  onOpen?: (index: number) => void;
  /** A dot's radius in pixels at the opening view: small for the whole map, bigger for a piece of it. */
  dotRadius?: number;
  /** The other papers' opacity while one is selected. */
  dimmed?: number;
  /**
   * Set in a page that scrolls (the paper page's minimap): the wheel scrolls the page, and zooms only with ⌘ or Ctrl.
   */
  embedded?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const deck = useRef<Deck<OrthographicView> | null>(null);
  const opening = useRef(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const [moved, setMoved] = useState(false);
  const pointsAt = useRef(positions);
  useEffect(() => {
    pointsAt.current = positions;
  });
  const everyPoint = useMemo(() => new Float32Array(positions.length / 2).fill(1), [positions]);
  const handlers = useRef({ onHover, onSelect, onOpen });
  useEffect(() => {
    handlers.current = { onHover, onSelect, onOpen };
  });

  // ⌘- or Ctrl-click opens, like a link; a plain click selects.
  const click = (index: number, e: Event) => {
    const { onOpen, onSelect } = handlers.current;
    if (onOpen && e instanceof MouseEvent && (e.metaKey || e.ctrlKey)) onOpen(index);
    else onSelect(index);
  };

  useEffect(() => {
    const el = parent.current!;
    opening.current = Math.log2((Math.min(el.clientWidth, el.clientHeight) / MAP_SIZE) * 0.95);
    const initialViewState = homeView(opening.current);
    deck.current = new Deck({
      parent: el,
      views: new OrthographicView({ flipY: false }),
      initialViewState,
      controller: { type: embedded ? EmbeddedController : PanController, doubleClickZoom: true, inertia: true },
      touchAction: embedded ? 'pan-x pan-y' : 'none',
      getCursor: ({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
      onViewStateChange: ({ viewState }) => {
        const view = viewState as OrthographicViewState;
        setZoom(view.zoom as number);
        setMoved(awayFromHome(view, opening.current, el));
      },
      onClick: (info) => {
        if (!info.picked) handlers.current.onSelect(null);
      },
    });
    setZoom(opening.current);
    // iOS Safari can still zoom the page on a pinch over the map; refusing its own gesture events stops it.
    const refuse = (e: Event) => e.preventDefault();
    for (const type of SAFARI_GESTURES) el.addEventListener(type, refuse, { passive: false });
    return () => {
      for (const type of SAFARI_GESTURES) el.removeEventListener(type, refuse);
      deck.current?.finalize();
      deck.current = null;
      // finalize() leaves the canvas it made in `parent`; a remount (Strict Mode's, in dev) would stack below it.
      el.replaceChildren();
    };
    // `embedded` is fixed for a figure's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Embedded, the wheel scrolls the page and zooms only with ⌘ or Ctrl held (a trackpad pinch
  // arrives as Ctrl + wheel), as an embedded Google map does. Caught on the way down, before
  // deck's own listener on the canvas: a plain wheel is stopped there, and not prevented, so the page scrolls.
  useEffect(() => {
    if (!embedded) return;
    const el = parent.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, [embedded]);

  const reset = () => {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    deck.current?.setProps({
      initialViewState: {
        ...homeView(opening.current),
        transitionDuration: still ? 0 : 400,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
      },
    });
  };

  useEffect(() => {
    if (!focus || !deck.current) return;
    const i = focus.index;
    const at = pointsAt.current;
    deck.current.setProps({
      initialViewState: {
        target: [at[2 * i], at[2 * i + 1], 0],
        zoom: Math.max(zoom ?? opening.current, opening.current + 3),
        minZoom: opening.current - 1,
        maxZoom: opening.current + 9,
        transitionDuration: 600,
        transitionInterpolator: new LinearInterpolator(['target', 'zoom']),
      },
    });
    // Only a new focus flies. Not new positions either: a redraw sends them every frame as it settles,
    // and each one flew the view back, so the map could not be panned or zoomed until it stopped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

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
        getRadius: dotRadius,
        radiusScale: scale,
        radiusMinPixels: 1,
        opacity: dimmed ? dimmedOpacity : 1,
        pickable: true,
        onHover: ({ index, x, y }) => handlers.current.onHover(index >= 0 ? { index, x, y } : null),
        onClick: ({ index }, event) => click(index, event.srcEvent),
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
          getRadius: dotRadius * scale + 3,
          updateTriggers: { getPosition: positions, getRadius: [scale, dotRadius] },
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
          // The data is the same array while a redraw moves the points: without these the lines stay where they were.
          updateTriggers: { getSourcePosition: [positions, selected], getTargetPosition: positions },
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
          onClick: ({ object }, event) =>
            object === undefined ? handlers.current.onSelect(null) : click(object, event.srcEvent),
          updateTriggers: { getPosition: positions, getFillColor: [selected, colours], getRadius: selected },
        }),
      labels.length > 0 &&
        new TextLayer<TopicLabel, CollisionFilterExtensionProps<TopicLabel>>({
          id: `labels-${level}`,
          data: labels,
          getPosition: (d) => [d.x, d.y],
          getText: (d) => d.text,
          getSize: level === 'region' ? 14 : 13,
          getColor: INK,
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontWeight: 'bold',
          characterSet: 'auto',
          // A halo in the page's colour, not a box: dots stay visible round the letters.
          fontSettings: LABEL_FONT,
          outlineWidth: LABEL_HALO,
          outlineColor: [251, 250, 247, 255],
          extensions: [new CollisionFilterExtension()],
          getCollisionPriority: (d) => d.size,
        }),
    ];
    deck.current.setProps({ layers });
  }, [
    positions,
    colours,
    shown,
    everyPoint,
    starred,
    held,
    regions,
    clusters,
    labelMode,
    selected,
    neighbours,
    zoom,
    dotRadius,
    dimmedOpacity,
  ]);

  return (
    <div className="relative h-full w-full">
      <div ref={parent} className="relative h-full w-full" />
      {moved && (
        <button
          type="button"
          className="absolute top-2 right-2 z-10 cursor-pointer border border-frame bg-card/95 px-2 py-0.5 font-sans text-xs hover:border-ink"
          onClick={reset}
        >
          Reset view
        </button>
      )}
    </div>
  );
}

/** Where the map opens: the whole of it, centred. */
function homeView(opening: number): OrthographicViewState {
  return {
    target: [MAP_SIZE / 2, MAP_SIZE / 2, 0],
    zoom: opening,
    minZoom: opening - 1,
    maxZoom: opening + 9,
  };
}

/** Whether the view has been panned or zoomed off where it opened, by more than a fraction of a pixel. */
function awayFromHome(view: OrthographicViewState, opening: number, el: HTMLElement): boolean {
  const zoom = view.zoom as number;
  const [x, y] = view.target as number[];
  const pixels = 2 ** zoom * Math.hypot(x - MAP_SIZE / 2, y - MAP_SIZE / 2);
  const grown = Math.abs(2 ** (zoom - opening) - 1) * Math.min(el.clientWidth, el.clientHeight);
  return pixels > HOME_TOLERANCE || grown > HOME_TOLERANCE;
}
