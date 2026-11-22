import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Resolves on any exit code; rejects only when the command can't start or `signal` aborts it. */
export const run: Runner = (cmd, args, { cwd, input, signal, env } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, signal, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") reject(new Error(`${cmd} not found on PATH`));
      else reject(err);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input != null) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });

export function firstErrorLine(res: RunResult): string {
  return (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/, 1)[0] || `exit code ${res.code}`;
}
