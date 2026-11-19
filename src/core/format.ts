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

export function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

export type Tone = "green" | "yellow" | "red" | "dim";

export const CI_STYLE: Record<CiState, { glyph: string; tone: Tone }> = {
  SUCCESS: { glyph: "✓", tone: "green" },
  PENDING: { glyph: "●", tone: "yellow" },
  FAILURE: { glyph: "✗", tone: "red" },
  ERROR: { glyph: "✗", tone: "red" },
  NONE: { glyph: "·", tone: "dim" },
};
