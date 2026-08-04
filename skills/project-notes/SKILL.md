---
name: project-notes
description: Reviews durable repository knowledge learned during the current work and, with explicit user approval, updates the project AGENTS.md. Use after discovering non-obvious commands, workflows, architecture, conventions, environment constraints, or gotchas that future coding sessions should know.
---

# Project Notes

Keep durable project guidance current by publishing approved learnings directly to the repository's project-level `AGENTS.md`.

`AGENTS.md` is the only source of truth. Do not create `.pi/project-notes.json`, a notes inbox, or any other intermediate storage.

## Standard

A candidate note must be all of the following:

- **Repository-specific:** it would not apply unchanged to most projects.
- **Durable:** it should remain useful beyond the current task and session.
- **Actionable:** it changes how a future coding agent should work.
- **Verified:** it is supported by repository files, successful or failed commands, test behavior, or an explicit user statement.
- **High-signal:** omitting it would make a future agent meaningfully less effective or more likely to make a mistake.
- **Project-wide:** it is appropriate guidance for future agents working on the repository, not just for the current user, checkout, task, or branch state.

Good candidates include:

- The real build, test, lint, typecheck, generation, or deployment command when the obvious command is wrong or incomplete.
- A required follow-up action after changing particular files.
- A non-obvious architectural boundary or dependency.
- A repository-specific convention enforced by tooling or review.
- An environment constraint or recurring failure mode with a confirmed cause.

Do not publish:

- Current task status, temporary plans, or one-off debugging details.
- Generic engineering advice.
- Unverified hypotheses or conclusions based only on absence of evidence.
- Secrets, credentials, private data, or values from environment files.
- Personal preferences that are not confirmed project requirements.
- Local checkout state such as untracked directories, a dirty working tree, temporary branches, current commit placement, or files that only this user must avoid.
- Branching, staging, or commit preferences unless the user explicitly confirms they are durable project-wide policy.
- Long file inventories, documentation dumps, or facts a coding agent can rediscover immediately without risk.
- Duplicates or weaker restatements of existing `AGENTS.md` guidance.

## Workflow

1. Identify the repository root. In a Git repository, confirm it with `git rev-parse --show-toplevel`; otherwise use repository manifests and structure. Target the project-level `AGENTS.md` at that root, not a module-level file, unless the user explicitly requests narrower scope.
2. Read the existing target `AGENTS.md` completely when it exists. Preserve useful content, organization, and tone.
3. Review the current conversation and tool evidence for durable learnings. Treat compaction summaries and assistant claims as leads, not final evidence. Revalidate every candidate against current repository files, command results, tests, or an explicit user statement. Omit a candidate when it cannot be verified without guesswork.
4. Compare verified evidence with the relevant existing `AGENTS.md` text. Treat stale, incomplete, or contradictory guidance as a correction candidate; do not append a new note while leaving conflicting guidance in place.
5. Before proposing guidance about branches, commits, staging, untracked files, absolute local paths, or current working-tree state, establish that it is durable project-wide policy. If scope is ambiguous, ask a focused question first; otherwise omit it.
6. Produce at most 10 independent candidate notes or corrections. For each candidate, prepare:
   - concise proposed wording suitable for `AGENTS.md`;
   - the target section;
   - a brief evidence statement;
   - why a future agent needs it.
7. Remove candidates that are speculative, redundant, overly detailed, local-only, temporary, or already documented accurately.
8. If no candidate survives, state that no durable project guidance was found and do not modify files.
9. Obtain explicit approval before editing:
   - When `ask_user` is available, use one call containing one question per candidate.
   - Provide exactly two model-supplied options in this order: `Do not publish` first as the safe default, then `Publish as written`.
   - The automatically available free-form answer lets the user provide revised wording or instructions.
   - If interactive questions are unavailable, present the candidates in plain text and wait for the user's response.
10. Treat a free-form answer as requested revision guidance. Resolve any ambiguity before editing. Never infer approval from silence or from an unanswered/default selection.
11. Before editing, reconcile approved notes with nearby existing guidance. Combine overlaps and resolve contradictions. If this requires materially changing approved wording, show the revised wording and obtain approval again.
12. Apply only approved wording. Prefer small, precise edits to the existing file. Create `AGENTS.md` only when it does not exist and at least one note was approved.
13. Re-read the complete resulting `AGENTS.md`, not only the changed section. Remove accidental duplication, vague wording, unsupported claims, stale nearby statements, and unnecessary prose. When Git is available, run `git diff --check -- AGENTS.md` and inspect the final diff.
14. Report what was added, corrected, or removed, where it was placed, and which current evidence supports it.

## Writing Style

- Use short sections and bullets.
- Write direct instructions rather than a session narrative.
- Include exact commands, repository-relative paths, and conditions when they matter; avoid machine-specific absolute paths unless the repository genuinely requires them.
- Explain the reason only when it prevents misuse or clarifies a non-obvious constraint.
- Integrate notes into the most relevant existing section instead of appending a generic notes log.
- Keep every line worth its ongoing context cost.

## Approval Question Pattern

For each candidate, ask a question equivalent to:

```text
Proposed AGENTS.md note:
"Run unit tests from the repository root with `npm run test:unit`; running from a package directory misses workspace setup."

Target section: Testing
Evidence: the package-level command failed, while the root script completed successfully.
Why retain it: future agents are likely to run the plausible command from the wrong directory.
```

Use stable candidate IDs and short navigation labels. Present `Do not publish` as option 1 and `Publish as written` as option 2. Do not add a free-form option yourself because `ask_user` supplies it automatically.
