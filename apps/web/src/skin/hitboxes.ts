import type { Hitbox, LoadedSkin, Rect } from './types';
import type { Point } from './geometry';

export interface ParsedPolygon { id: string; label: string; points: Point[] }

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
};

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * Reads the <polygon> elements of a hitboxes.svg (viewBox 0 0 1 1): id, points and the <title> text.
 * Polygons with an unparsable or out-of-range point list are dropped and reported through `problems`.
 */
export function parseHitboxSvg(svg: string, problems: string[] = []): ParsedPolygon[] {
  const out: ParsedPolygon[] = [];
  const re = /<polygon\b([^>]*)>(?:\s*<title>([\s\S]*?)<\/title>\s*)?(?:<\/polygon>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const tag = ` ${m[1] ?? ''}`;
    const id = attr(tag, 'id');
    const raw = attr(tag, 'points');
    if (!id || !raw) { problems.push('polygon without id or points'); continue; }
    const nums = raw.trim().split(/[\s,]+/).map(Number);
    if (nums.length < 6 || nums.length % 2 || nums.some((n) => !Number.isFinite(n) || n < -0.001 || n > 1.001)) { problems.push(`polygon ${id}: bad points`); continue; }
    const points: Point[] = [];
    for (let i = 0; i < nums.length; i += 2) points.push([nums[i]!, nums[i + 1]!]);
    out.push({ id, label: decode((m[2] ?? id).trim()) || id, points });
  }
  return out;
}

export function polygonPath(points: Point[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

function within(box: Hitbox, rect: Rect): boolean {
  return box.points.every(([x, y]) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
}

export function cropHitboxes(boxes: Hitbox[], rect: Rect): Hitbox[] {
  return boxes.filter(box => within(box, rect)).map(box => ({
    ...box, points: box.points.map(([x, y]) => [(x - rect.x) / rect.width, (y - rect.y) / rect.height]),
  }));
}

/** Use the photographed controls below a portrait LCD or to either side of a landscape LCD. */
export function keypadCrops(skin: LoadedSkin): Rect[] {
  const full = skin.config.views.full;
  if (full.controls !== 'buttons' || skin.config.input?.kind === 'touchscreen') return [];
  if (full.width >= full.height) {
    const right = full.screenRect.x + full.screenRect.width;
    const sides = [
      { x: 0, y: 0, width: full.screenRect.x, height: 1 },
      { x: right, y: 0, width: 1 - right, height: 1 },
    ];
    return sides.every(rect => skin.hitboxes.some(box => box.action && within(box, rect))) ? sides : [];
  }
  const bottom = full.screenRect.y + full.screenRect.height;
  const controls = skin.hitboxes.filter(box => box.action && box.points.every(([, y]) => y >= bottom));
  if (controls.length === 0) return [];
  const first = Math.min(...controls.flatMap(box => box.points.map(([, y]) => y)));
  const cut = (first + bottom) / 2;
  return [{ x: 0, y: cut, width: 1, height: 1 - cut }];
}
