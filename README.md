# hunk-gh-stacked-pr

A [hunk](https://hunk.dev) extension for reviewing GitHub PRs — threads, CI checks, timeline, merge, metadata, and stacked-PR switching — without leaving the terminal.

Patterns borrowed with thanks from [phl28/hunk-gh-review](https://github.com/phl28/hunk-gh-review).

## Install

Requires hunk ≥ 0.19 (declares `apiVersion: 6`) and an authenticated [`gh`](https://cli.github.com). Stack features light up when the official [`gh stack`](https://gh.io/stacks) extension is installed and the branch is stack-tracked; plain base-ref chains (Graphite, hand-rolled) are detected without it.

```bash
hunk extension install <owner>/hunk-gh-stacked-pr
```

## Usage

Branch-first: check out the branch, launch hunk against the PR's merge-base, and the extension resolves the PR itself. The bundled launcher computes the right base:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/hunk-gh-stacked-pr/main/scripts/hunkpr -o ~/.local/bin/hunkpr
chmod +x ~/.local/bin/hunkpr

hunkpr   # = hunk diff $(merge-base of the PR's actual base branch)
```

Inside hunk:

- **`P`** — toggle the PR pane (Overview / Checks / Threads tabs) and enter its keyboard mode.
- **`S`** — submit session notes (`c` on a line) as one atomic GitHub review: Comment / Approve / Request changes.

In the pane's mode:

| Key | Action |
| --- | --- |
| `tab` / `1` `2` `3` | switch tab (`c` stays hunk's leave-a-note key) |
| `j`/`k`, `g`/`G` | move selection (threads follow in the diff) |
| `enter` | overview: switch to selected stack PR · checks: failed-log peek · threads: reveal line |
| `[` / `]` | switch to previous / next PR in the stack (guarded checkout + session reload) |
| `s` | submit review |
| `m` / `M` | merge PR (guarded, auto-merge offer while checks pend) / merge whole stack via `gh stack merge` |
| `r` / `x` / `h` | reply to thread / resolve-unresolve / show-hide resolved |
| `e` | edit metadata: title, body, labels, reviewers, mark-ready |
| `C` | post a top-level PR comment |
| `u` | rerun failed workflow runs |
| `R` | refresh PR state |
| `q` / `esc` | leave the mode |

Checks auto-refresh every 30s while any check is pending (see `poll_seconds`). Lines with unresolved threads are tinted in the diff. Switching stacks refuses a dirty worktree (offers a stash), delegates to `gh stack checkout` when tracked, and retargets the live session via `hunk session reload`.

## Config

```toml
[extension.hunk-gh-stacked-pr]
placement = "right"      # left | right | top | bottom
poll_seconds = 30
delete_branch = true     # pass --delete-branch on merge; unset = repo default
hide_resolved = true
log_lines = 200

[keybindings]
# "hunk-gh-stacked-pr.open" = "ctrl+p"
# "hunk-gh-stacked-pr.submit" = "ctrl+s"
```

## Develop

```bash
bun install
bun run typecheck
bun test
```

Test live from any PR branch: `hunkpr` after adding the checkout to `[extensions] paths` in `~/.config/hunk/config.toml`, or `hunk diff <merge-base> --extension /path/to/hunk-gh-stacked-pr`.

This repo loads itself as a repo-local extension via `.hunk/extensions/hunk-gh-stacked-pr.ts` (trust prompt on first run). JSX transpiles to a `react/jsx-dev-runtime` import hunk doesn't map, so every checkout that loads it needs `node_modules` — run `bun install` or symlink it into worktrees.
