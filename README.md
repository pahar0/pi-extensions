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
| `codex-web-search`        | Adds structured `web_search`, `web_fetch`, `web_find`, and batched `web_run` tools with safe HTTP fallback.                      |
| `diff`                    | Adds `/diff` and `show_diff` to review and annotate Git changes across repositories.                   |
| `init`                    | Adds `/init` to survey a repository and create or improve project guidance in `AGENTS.md`.              |
| `resource-manager`        | Adds commands for enabling, disabling, and uninstalling custom extensions and skills.                   |
| `continue-agent-turn`     | Continues the current agent turn with `Ctrl+R`, retrying interrupted attempts when necessary.          |
| `status-footer`           | Replaces the footer with cwd, usage, context, model, thinking, and extension status info.               |
| `transcribe`              | Adds local speech-to-text dictation, a live recording meter, and `/transcribe` settings.                |

### Development

Run `npm run check` for TypeScript validation and `npm test` for the regression suites.
