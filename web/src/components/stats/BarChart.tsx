import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { type BarSlots, barPath, barSlots, niceScale, peakOf, shortDay, xTickIndexes } from '../../lib/stats';

export interface BarDatum {
  day: string;
  value: number;
}

const HEIGHT = 180;
const TOP = 8;
const X_AXIS = 22;
const BASELINE = HEIGHT - X_AXIS;
const PLOT_H = BASELINE - TOP;
/** Approximate width of one 12px tabular digit, for the y label gutter. */
const DIGIT = 7.2;

/** Container width in px (0 until measured); follows resizes. */
function useWidth<T extends Element>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface Geometry {
  gutter: number;
  slots: BarSlots;
  y: (v: number) => number;
  xCenter: (i: number) => number;
}

function geometry(width: number, data: BarDatum[], format: (n: number) => string) {
  const scale = niceScale(peakOf(data.map((d) => d.value)));
  const gutter = Math.ceil(Math.max(...scale.ticks.map((v) => format(v).length)) * DIGIT) + 10;
  const slots = barSlots(data.length, Math.max(0, width - gutter));
  const geo: Geometry = {
    gutter,
    slots,
    y: (v) => BASELINE - (scale.max > 0 ? (v / scale.max) * PLOT_H : 0),
    xCenter: (i) => gutter + (i + 0.5) * slots.slot,
  };
  return { scale, geo };
}

function GridLines({
  ticks,
  geo,
  width,
  format,
}: {
  ticks: number[];
  geo: Geometry;
  width: number;
  format: (n: number) => string;
}) {
  return (
    <g>
      {ticks.map((v) => (
        <g key={v}>
          <line
            className={v === 0 ? 'chart-base' : 'chart-grid'}
            x1={geo.gutter}
            x2={width}
            y1={geo.y(v) + 0.5}
            y2={geo.y(v) + 0.5}
          />
          <text className="chart-label" x={geo.gutter - 8} y={geo.y(v)} textAnchor="end" dominantBaseline="middle">
            {format(v)}
          </text>
        </g>
      ))}
    </g>
  );
}

function XLabels({ data, geo, width }: { data: BarDatum[]; geo: Geometry; width: number }) {
  const last = data.length - 1;
  return (
    <g>
      {xTickIndexes(data.length).map((i) => {
        const d = data[i];
        if (!d) return null;
        let x = geo.xCenter(i);
        let anchor: 'start' | 'middle' | 'end' = 'middle';
        if (last > 0 && i === 0) {
          x = geo.gutter;
          anchor = 'start';
        } else if (last > 0 && i === last) {
          x = width;
          anchor = 'end';
        }
        return (
          <text key={d.day} className="chart-label" x={x} y={HEIGHT - 4} textAnchor={anchor}>
            {shortDay(d.day)}
          </text>
        );
      })}
    </g>
  );
}

function Bars({
  data,
  geo,
  active,
  onHover,
}: {
  data: BarDatum[];
  geo: Geometry;
  active: number | null;
  onHover: (i: number) => void;
}) {
  const { slot, bar } = geo.slots;
  return (
    <g>
      {data.map((d, i) => {
        const x = geo.gutter + i * slot + (slot - bar) / 2;
        const h = d.value > 0 ? Math.max(2, BASELINE - geo.y(d.value)) : 0;
        return (
          <g key={d.day} onPointerEnter={() => onHover(i)}>
            <rect className="chart-hit" x={geo.gutter + i * slot} y={TOP} width={slot} height={PLOT_H} />
            {h > 0 && (
              <path className={`chart-bar${active === i ? ' is-active' : ''}`} d={barPath(x, BASELINE, bar, h)} />
            )}
          </g>
        );
      })}
    </g>
  );
}

/**
 * Single-series daily bar chart drawn as SVG in real pixels (re-measured on resize, so 12px text stays 12px).
 * Hover shows a tooltip; the page offers the same numbers as a table for keyboard and screen-reader users.
 */
export function BarChart({
  data,
  label,
  tooltip,
  format,
}: {
  data: BarDatum[];
  /** Accessible summary of the whole chart. */
  label: string;
  tooltip: (index: number) => string;
  format: (n: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const { scale, geo } = geometry(width, data, format);
  const cur = active === null ? undefined : data[active];

  let tipClass = 'chart-tip';
  if (active !== null && width > 0) {
    const left = geo.xCenter(active);
    if (left < width * 0.2) tipClass += ' chart-tip-start';
    else if (left > width * 0.8) tipClass += ' chart-tip-end';
  }

  return (
    <div className="chart" ref={ref} onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg role="img" aria-label={label} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`}>
          <GridLines ticks={scale.ticks} geo={geo} width={width} format={format} />
          <Bars data={data} geo={geo} active={active} onHover={setActive} />
          <XLabels data={data} geo={geo} width={width} />
        </svg>
      )}
      {active !== null && cur && (
        <div className={tipClass} style={{ left: geo.xCenter(active), top: geo.y(cur.value) - 8 }} aria-hidden="true">
          {tooltip(active)}
        </div>
      )}
    </div>
  );
}
