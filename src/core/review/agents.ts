import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { firstErrorLine, type RunResult } from "../exec.ts";
import { REVIEW_DRAFT_SCHEMA } from "./schema.ts";
import type { Workspace } from "./workspace.ts";

export const AGENT_IDS = ["claude", "gemini", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface AgentRun {
  prompt: string;
  systemPrompt: string;
  model?: string;
  ws: Workspace;
}

export interface Agent {
  /** Also the binary name. */
  id: AgentId;
  label: string;
  /** Set when the agent's read-only mode can't run `gh`, so the PR diff must be written into the workspace. */
  needsDiffFile: boolean;
  /** Set when the CLI has no schema flag, so the prompt has to carry the JSON schema. */
  inlineSchema: boolean;
  /** `read` turns the finished process into the raw draft for `parseDraft`, throwing on failure. */
  headless(run: AgentRun): { args: string[]; read(res: RunResult): unknown };
  interactive(run: AgentRun): string[];
  /** Interactive with the CLI's normal write permissions, run in the user's checkout. */
  fix(run: FixRun): string[];
}

export type FixRun = Pick<AgentRun, "prompt" | "systemPrompt" | "model">;

export const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr view:*)",
];
export const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

const modelArgs = (model: string | undefined, flag = "--model") => (model ? [flag, model] : []);
const withSystemPrompt = ({ prompt, systemPrompt }: FixRun) => `${systemPrompt}\n\n${prompt}`;

/** The tool flags are variadic, so callers put positionals first. */
function claudeArgs({ systemPrompt, model, ws }: AgentRun, extraAllowed: string[] = []): string[] {
  return [
    ...modelArgs(model),
    "--append-system-prompt",
    systemPrompt,
    "--add-dir",
    ws.contextDir,
    "--allowedTools",
    ...ALLOWED_TOOLS,
    ...extraAllowed,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
  ];
}

const claude: Agent = {
  id: "claude",
  label: "Claude",
  needsDiffFile: false,
  inlineSchema: false,
  headless: (run) => ({
    args: ["-p", run.prompt, "--output-format", "json", "--json-schema", JSON.stringify(REVIEW_DRAFT_SCHEMA), ...claudeArgs(run)],
    read(res) {
      let out: { is_error?: boolean; result?: string; structured_output?: unknown };
      try {
        out = JSON.parse(res.stdout);
      } catch {
        throw new Error(`claude failed: ${firstErrorLine(res)}`);
      }
      if (res.code !== 0 || out.is_error) throw new Error(`claude failed: ${out.result ?? firstErrorLine(res)}`);
      return out.structured_output;
    },
  }),
  // /code-review is a skill that fans out to subagents.
  interactive: (run) => [run.prompt, ...claudeArgs(run, ["Skill", "Agent"])],
  fix: (run) => [run.prompt, ...modelArgs(run.model), "--append-system-prompt", run.systemPrompt],
};

/** Pulls a JSON object out of a model reply that may wrap it in a code fence or prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("reply wasn't valid JSON");
  }
}

// Headless Gemini denies every tool that would ask for approval (shell, writes), which keeps it read-only.
const gemini: Agent = {
  id: "gemini",
  label: "Gemini",
  needsDiffFile: true,
  inlineSchema: true,
  headless: (run) => ({
    args: ["--include-directories", run.ws.contextDir, ...modelArgs(run.model), "--output-format", "json", "-p", withSystemPrompt(run)],
    read(res) {
      let out: { response?: string; error?: { message?: string } };
      try {
        out = JSON.parse(res.stdout);
      } catch {
        throw new Error(`gemini failed: ${firstErrorLine(res)}`);
      }
      if (res.code !== 0 || out.error || typeof out.response !== "string") {
        throw new Error(`gemini failed: ${out.error?.message ?? firstErrorLine(res)}`);
      }
      try {
        return extractJson(out.response);
      } catch (err) {
        throw new Error(`gemini failed: ${(err as Error).message}`);
      }
    },
  }),
  interactive: (run) => ["--include-directories", run.ws.contextDir, ...modelArgs(run.model), "-i", withSystemPrompt(run)],
  fix: (run) => [...modelArgs(run.model), "-i", withSystemPrompt(run)],
};

const codex: Agent = {
  id: "codex",
  label: "Codex",
  needsDiffFile: true,
  inlineSchema: false,
  headless(run) {
    const schemaPath = join(run.ws.contextDir, "review-schema.json");
    const outPath = join(run.ws.contextDir, "last-message.json");
    writeFileSync(schemaPath, JSON.stringify(REVIEW_DRAFT_SCHEMA));
    return {
      args: [
        "exec",
        "--sandbox",
        "read-only",
        // The workspace is a plain temp dir when the repo isn't checked out locally.
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outPath,
        ...modelArgs(run.model),
        withSystemPrompt(run),
      ],
      read(res) {
        if (res.code !== 0) throw new Error(`codex failed: ${firstErrorLine(res)}`);
        let text: string;
        try {
          text = readFileSync(outPath, "utf8");
        } catch {
          throw new Error("codex failed: no final message");
        }
        try {
          return extractJson(text);
        } catch (err) {
          throw new Error(`codex failed: ${(err as Error).message}`);
        }
      },
    };
  },
  interactive: (run) => ["--sandbox", "read-only", ...modelArgs(run.model), withSystemPrompt(run)],
  fix: (run) => [...modelArgs(run.model), withSystemPrompt(run)],
};

export const AGENTS: Record<AgentId, Agent> = { claude, gemini, codex };

export function onPath(bin: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && exts.some((ext) => existsSync(join(dir, bin + ext))));
}

/** Installed agents in registry order, with `preferred` first when it's installed. */
export function availableAgents(preferred: AgentId, isInstalled = onPath): Agent[] {
  const installed = AGENT_IDS.filter((id) => isInstalled(id)).map((id) => AGENTS[id]);
  return [...installed.filter((a) => a.id === preferred), ...installed.filter((a) => a.id !== preferred)];
}
