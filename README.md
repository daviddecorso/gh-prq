# gh-prq

Turn-based pull request queue for the GitHub CLI. Answers "whose turn is it?" for every open PR you're involved in.

<img width="1077" height="331" alt="image" src="https://github.com/user-attachments/assets/d40dfb4e-5464-4acc-8e0e-66118b081469" />

## Install

Requires the GitHub CLI and Node 22.18+.

```sh
gh extension install daviddecorso/gh-prq
gh prq
```

The first run (and the first run after `gh extension upgrade prq`) installs dependencies with `npm ci`.

To install from a local checkout, run `gh extension install .` (the directory must be named `gh-prq`).

## Develop

Requires Node 22.18+ (runs the TypeScript directly, no build step).

```sh
npm install
npm test
npm run typecheck
npm run lint        # lint:fix to auto-format and apply safe fixes
node src/cli/index.ts --plain
```

## Layout

- `src/core/` has no UI dependencies (GraphQL fetch, classifier, cache, config) and is reused by every frontend.
- `src/cli/` holds the arg parser, shared item filter, and the `--plain` and `--json` renderers.
- `src/tui/` is the Ink TUI. Components are plain `.ts` using `React.createElement` (Node's type stripping can't run `.tsx`); `model.ts` holds the pure row/cursor/scroll logic.
- `test/` covers each bucket transition, the TUI model, and the TUI app via `ink-testing-library`.

`gh prq` opens the TUI in the alternate screen when stdin and stdout are TTYs, otherwise it prints `--plain`. For scripts and widgets, `--json --envelope` prints `{ viewer, fetchedAt, staleReason, warnings, items }` so a consumer can tell how fresh the queue is and whether it came from a stale cache; plain `--json` prints just the items. `--count` prints just the number of PRs that need you, after the other filters, for a status bar; it reads the cache like every other mode, so frequent polling stays cheap. The TUI shows the last cached queue immediately and refreshes in the background. Press `?` in the TUI for keys. `/` filters by space-separated terms across repo, title, `@author`, reason, badges, `ci:` state, `is:draft`, `is:new`, and `is:snoozed` (esc clears), `]`/`[` jump between buckets, and `J`/`K` scroll the info pane (`ui.showDetailByDefault` defaults to `"auto"`, opening on terminals `>= 180` columns; manual `i` uses a side pane at `>= 120`). `--exclude <glob>` (repeatable) and `filters.excludeRepos` hide repos: `acme/*` matches an owner, a bare `legacy-*` matches the repo name under any owner. PRs you only commented on (never reviewed, never requested) show up once the author replies; set `filters.includeCommentOnly` to `false` or pass `--hide-comment-only` to keep the queue to PRs you review. `ui.autoRefreshSeconds` in `~/.config/gh-prq/config.json` sets the background refresh (default 300, `0` disables).

The queue includes open PRs you've only commented on, not just ones you reviewed or were asked to review. A `●` marks PRs that became actionable since the last load (including since your last session), and the header counts them; the mark clears once the cursor moves off the row. When a background refresh turns up new ones, the terminal bell rings.

On your own PRs, `M` merges a ready PR (pick squash, merge or rebase; branch protection and required checks still apply), `D` marks a draft ready for review, and `R` re-requests review from everyone who reviewed it before (excluding active approvers and anyone currently requested). Each asks first.

`z` snoozes the selected PR until something changes: its bucket, its latest activity, or its head commit. Snoozed PRs are hidden from the TUI, `--plain`, `--json` and `--count`. `Z` toggles them dimmed in the TUI, and `--all` includes them everywhere (including starting the TUI with snoozed PRs shown). Snoozes live in `~/.cache/gh-prq/snoozed.json` and expire after 30 days.

## Agent reviews

In the TUI, `a` has an AI agent draft a review in the background, and `A` exits into an interactive session with it seeded with the same context. gh-prq runs whichever of these CLIs is on your PATH, read-only, with that CLI's own login (gh-prq never handles API keys):

- `claude` (Claude Code)
- `gemini` (Gemini CLI)
- `codex` (Codex CLI)

`agent.default` picks the agent you start with (default `claude`). With more than one installed, `m` switches the active agent and the header shows which one is active (`⇄ gemini`). Each draft remembers which agent wrote it.

If the cwd is a clone of the PR's repo, the agent gets a throwaway `git worktree` at the PR head. Otherwise it only sees the diff. Re-reviews look at the commits since your last review and report whether each of your open threads was addressed.

A finished draft rings the terminal bell and shows in the info pane (`i`); `d` opens the full details reader with the draft first, where you can scroll and post (`p`) directly. `p` posts it: `c` comment, `a` approve, or `r` request changes submits it right away with the draft's summary as the review body, `p` leaves it as a pending review to edit and submit in the browser, and enter picks the verdict the agent suggested. Then `x` cancels or discards. Drafts persist in `~/.cache/gh-prq/drafts/` across restarts and are deleted after 30 days.

`f` is for the other side of a review. It collects everything posted since the PR's last commit (unresolved inline review threads, review summaries, and discussion comments, skipping your own and bots'), runs `gh pr checkout` in the cwd, and opens the active agent interactively on that branch with the feedback as its first prompt. Unlike `a` and `A`, this agent can edit files (with its CLI's normal permission prompts); it's told not to commit or push unless you ask.

With Claude, a few of these run Claude Code's built-in commands instead of our prompts. `A` starts `/code-review` on the PR, or on the commits since your last review when the repo is checked out. `f` ends by running `/code-review --fix` over its changes. `S` checks out your own PR and starts `/steward` (Claude Code v2.1.330+), which keeps working on review feedback and failing checks, and commits, pushes, and replies to reviewers as you until you run `/ship stop`. Background drafts (`a`) still use our prompt, because `/code-review` doesn't return the structured draft that `p` posts. Set `agent.claudeBuiltins` to `false` to turn all of this off, and `agent.reviewEffort` (`low` to `max`) to pin the `/code-review` effort level.

```json
{
  "agent": {
    "default": "claude",
    "models": { "claude": "sonnet", "gemini": "pro", "codex": "gpt-5" },
    "maxConcurrent": 2,
    "confirmBeforePosting": true
  }
}
```

An agent without a `models` entry uses its CLI's default. The old `claude.model`, `claude.maxConcurrent`, and `claude.confirmBeforePosting` keys still work.

## Status

- Phase 1 (core engine, `--plain`, `--json`): done
- Phase 2 (Ink TUI): done
- Phase 3 (agent review / re-review): done (remote `@claude` mode not implemented)
