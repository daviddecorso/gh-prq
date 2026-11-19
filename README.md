# gh-prq

Turn-based pull request queue for the GitHub CLI. Answers "whose turn is it?" for every open PR you're involved in.

## Develop

Requires Node 22.18+ (runs the TypeScript directly, no build step).

```sh
npm install
npm test
npm run typecheck
node src/cli/index.ts --plain
```

## Install as a gh extension

`gh extension install .` requires the directory to be named `gh-prq`.

```sh
gh extension install .
gh prq --plain
```

## Layout

- `src/core/` has no UI dependencies (GraphQL fetch, classifier, cache, config) and is reused by every frontend.
- `src/cli/` holds the arg parser, shared item filter, and the `--plain` renderer.
- `src/tui/` is the Ink TUI. Components are plain `.ts` using `React.createElement` (Node's type stripping can't run `.tsx`); `model.ts` holds the pure row/cursor/scroll logic.
- `test/` covers each bucket transition, the TUI model, and the TUI app via `ink-testing-library`.

`gh prq` opens the TUI when stdin and stdout are TTYs, otherwise it prints `--plain`. The TUI shows the last cached queue immediately and refreshes in the background. Press `?` in the TUI for keys. `--exclude <glob>` (repeatable) and `filters.excludeRepos` hide repos: `acme/*` matches an owner, a bare `legacy-*` matches the repo name under any owner. `ui.autoRefreshSeconds` in `~/.config/gh-prq/config.json` sets the background refresh (default 300, `0` disables).

## Status

- Phase 1 (core engine, `--plain`, `--json`): done
- Phase 2 (Ink TUI): done
- Phase 3 (Claude review / re-review): not started
