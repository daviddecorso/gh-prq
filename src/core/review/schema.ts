export type FollowUpStatus = "addressed" | "partial" | "not_addressed";

export interface DraftComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

export interface ThreadFollowUp {
  /** 1-based index into the threads listed in the prompt. */
  thread: number;
  path: string;
  status: FollowUpStatus;
  note: string;
}

export interface ReviewDraft {
  summary: string;
  comments: DraftComment[];
  threadFollowUps: ThreadFollowUp[];
  /** Advisory only; never sent as a review event. */
  suggestedVerdict: "approve" | "comment" | "request_changes";
}

export const REVIEW_DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "comments", "threadFollowUps", "suggestedVerdict"],
  properties: {
    summary: { type: "string", description: "Review body in Markdown. Short." },
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "line", "side", "body"],
        properties: {
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          side: { type: "string", enum: ["RIGHT", "LEFT"] },
          body: { type: "string" },
        },
      },
    },
    threadFollowUps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["thread", "path", "status", "note"],
        properties: {
          thread: { type: "integer", minimum: 1 },
          path: { type: "string" },
          status: { type: "string", enum: ["addressed", "partial", "not_addressed"] },
          note: { type: "string" },
        },
      },
    },
    suggestedVerdict: { type: "string", enum: ["approve", "comment", "request_changes"] },
  },
} as const;

export function parseDraft(value: unknown): ReviewDraft {
  const draft = value as Partial<ReviewDraft> | null;
  if (!draft || typeof draft.summary !== "string" || !Array.isArray(draft.comments)) {
    throw new Error("Claude returned no structured review");
  }
  return {
    summary: draft.summary,
    comments: draft.comments,
    threadFollowUps: Array.isArray(draft.threadFollowUps) ? draft.threadFollowUps : [],
    suggestedVerdict: draft.suggestedVerdict ?? "comment",
  };
}
