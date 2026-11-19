import type { CiState } from "./types.ts";

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

const graphemes = new Intl.Segmenter();
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;
/** Emoji (including VS16-upgraded text symbols) plus the East Asian Wide/Fullwidth blocks. */
const WIDE =
  /[\p{Emoji_Presentation}\u{FE0F}\u{1100}-\u{115F}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{20000}-\u{3FFFD}]/u;

function graphemeWidth(g: string): number {
  if (ZERO_WIDTH.test(g)) return 0;
  return WIDE.test(g) ? 2 : 1;
}

/** Terminal columns `text` occupies; emoji and CJK take two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) width += graphemeWidth(segment);
  return width;
}

export function padEndDisplay(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/** Truncates to `width` terminal columns, ending in "…" when cut. */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = graphemeWidth(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
}

export type Tone = "green" | "yellow" | "red" | "dim";

export const CI_STYLE: Record<CiState, { glyph: string; tone: Tone }> = {
  SUCCESS: { glyph: "✓", tone: "green" },
  PENDING: { glyph: "●", tone: "yellow" },
  FAILURE: { glyph: "✗", tone: "red" },
  ERROR: { glyph: "✗", tone: "red" },
  NONE: { glyph: "·", tone: "dim" },
};
