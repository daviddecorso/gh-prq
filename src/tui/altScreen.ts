import { constants as osConstants } from "node:os";

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type ExitSignal = (typeof EXIT_SIGNALS)[number];

export interface AltScreenApp {
  unmount(): void;
  waitUntilExit(): Promise<unknown>;
}

export interface AltScreenEnv {
  stdout?: { write(chunk: string): unknown };
  proc?: Pick<NodeJS.Process, "once" | "off">;
  exit?: (code: number) => void;
}

/** Runs an Ink app in the alternate screen buffer and restores the terminal on normal exit or signal death. */
export async function runInAltScreen(
  mount: () => AltScreenApp,
  { stdout = process.stdout, proc = process, exit = (code: number) => process.exit(code) }: AltScreenEnv = {},
): Promise<void> {
  let inAltScreen = false;
  let app: AltScreenApp | undefined;
  const leaveAltScreen = () => {
    if (!inAltScreen) return;
    inAltScreen = false;
    stdout.write("\x1b[?1049l");
  };

  let handledSignal = false;
  const signalHandlers: [ExitSignal, () => void][] = [];
  for (const sig of EXIT_SIGNALS) {
    signalHandlers.push([
      sig,
      () => {
        if (handledSignal) return;
        handledSignal = true;
        for (const [s, handler] of signalHandlers) proc.off(s, handler);
        proc.off("exit", leaveAltScreen);
        try {
          app?.unmount();
        } finally {
          leaveAltScreen();
          exit(128 + osConstants.signals[sig]);
        }
      },
    ]);
  }

  stdout.write("\x1b[?1049h\x1b[H");
  inAltScreen = true;
  proc.once("exit", leaveAltScreen);
  for (const [sig, handler] of signalHandlers) proc.once(sig, handler);

  try {
    app = mount();
    await app.waitUntilExit();
  } finally {
    for (const [sig, handler] of signalHandlers) proc.off(sig, handler);
    leaveAltScreen();
    proc.off("exit", leaveAltScreen);
  }
}
