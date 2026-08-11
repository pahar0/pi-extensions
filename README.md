# Pi Extensions

Personal extensions and skills for the [Pi coding agent](https://pi.dev/).

## Installation

Install globally with Pi's package manager:

```bash
pi install git:github.com/pahar0/pi-extensions
```

Pi loads the extensions declared by the package manifest. If Pi is already running, use `/reload` or restart Pi after installing.

## Extensions

| Extension                 | Description                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ask-user`                | Adds an `ask_user` wizard for 1–10 multiple-choice questions with an always-available free-form answer. |
| `autocomplete`            | Adds manual inline suggestions with `Alt+A`, an animated cursor, and `Tab`/`Escape` controls.           |
| `codex-web-search`        | Adds `web_search`, `web_fetch`, and `web_find` backed directly by Codex web search.                      |
| `init`                    | Adds `/init` to survey a repository and create or improve project guidance in `AGENTS.md`.              |
| `mutation-guard`          | Prompts for approval before file edits, writes, and risky shell mutations.                              |
| `resource-manager`        | Adds commands for enabling, disabling, and uninstalling custom extensions and skills.                   |
| `restore-files`           | Tracks file checkpoints and can restore code alongside conversation tree navigation.                   |
| `retry-interrupted-turn`  | Retries an aborted or failed agent turn with `Ctrl+R`, without adding or sending a user message.        |
| `status-footer`           | Replaces the footer with cwd, usage, context, model, thinking, and extension status info.               |
