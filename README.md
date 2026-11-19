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
- `src/cli/` holds the arg parser and the `--plain` renderer.
- `test/classifier.test.ts` covers each bucket transition.

## Status

- Phase 1 (core engine, `--plain`, `--json`): done
- Phase 2 (Ink TUI): not started, `gh prq` currently renders `--plain`
- Phase 3 (Claude review / re-review): not started
