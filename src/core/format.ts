import type { BucketId, CiState } from "./types.ts";

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
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: matches a bare VS16 inside a grapheme, not a combined pair.
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

export type Tone = "green" | "yellow" | "red" | "cyan" | "dim";

export const CI_STYLE: Record<CiState, { glyph: string; tone: Tone }> = {
  SUCCESS: { glyph: "✓", tone: "green" },
  PENDING: { glyph: "●", tone: "yellow" },
  FAILURE: { glyph: "✗", tone: "red" },
  ERROR: { glyph: "✗", tone: "red" },
  NONE: { glyph: "·", tone: "dim" },
};

export const BUCKET_TONE: Record<BucketId, Tone> = {
  NEEDS_REREVIEW: "yellow",
  NEEDS_INITIAL_REVIEW: "cyan",
  MY_PR_ACTION_NEEDED: "yellow",
  MY_PR_READY: "green",
  WAITING_ON_AUTHOR: "dim",
  MY_PR_WAITING: "dim",
  DRAFTS: "dim",
};

const ESCAPE_SEQ =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b\n]*(?:\x1b\\)?|\x1b[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x9c\x1b\n]*(?:\x07|\x9c|\x1b\\)?|[\x90\x98\x9e\x9f][^\x9c\x1b\n]*(?:\x9c|\x1b\\)?/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const SGR_RESET = /^\x1b\[0*m$/;
const SGR_CODE = /^\x1b\[[0-9;]*m$/;

/** Strips terminal escape sequences and control characters (including bare `\r`), preserving `\n` and `\t`. */
export function stripControlChars(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(ESCAPE_SEQ, "").replace(CONTROL_CHARS, "");
}

/** Wraps text to `width` terminal columns, keeping only SGR escapes and stripping control characters. */
export function wrapAnsiLines(text: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const out: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    let activeSgr = "";
    let line = "";
    let col = 0;
    let lastIndex = 0;

    const pushPlain = (chunk: string) => {
      const clean = chunk.replace(CONTROL_CHARS, "");
      for (const { segment } of graphemes.segment(clean)) {
        if (segment === "\t") {
          const spaces = 4 - (col % 4);
          if (col + spaces > maxWidth && col > 0) {
            out.push(activeSgr ? `${line}\x1b[0m` : line);
            line = activeSgr;
            col = 0;
          }
          const fit = Math.min(spaces, maxWidth - col);
          line += " ".repeat(fit);
          col += fit;
          continue;
        }
        const w = graphemeWidth(segment);
        if (col + w > maxWidth && col > 0) {
          out.push(activeSgr ? `${line}\x1b[0m` : line);
          line = activeSgr;
          col = 0;
        }
        line += segment;
        col += w;
      }
    };

    ESCAPE_SEQ.lastIndex = 0;
    for (const match of rawLine.matchAll(ESCAPE_SEQ)) {
      const idx = match.index!;
      if (idx > lastIndex) pushPlain(rawLine.slice(lastIndex, idx));
      const seq = match[0];
      if (SGR_RESET.test(seq)) {
        activeSgr = "";
        line += seq;
      } else if (SGR_CODE.test(seq)) {
        activeSgr += seq;
        line += seq;
      }
      lastIndex = idx + seq.length;
    }
    if (lastIndex < rawLine.length) pushPlain(rawLine.slice(lastIndex));
    out.push(activeSgr ? `${line}\x1b[0m` : line);
  }

  return out;
}
