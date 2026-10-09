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
| `init`                    | Adds `/init` to survey a repository and create or improve project guidance in `AGENTS.md`.              |
| `mutation-guard`          | Prompts for approval before file edits, writes, and risky shell mutations.                              |
| `resource-manager`        | Adds commands for enabling, disabling, and uninstalling custom extensions and skills.                   |
| `restore-files`           | Tracks file checkpoints and can restore code alongside conversation tree navigation.                   |
| `continue-agent-turn`     | Continues the current agent turn with `Ctrl+R`, retrying interrupted attempts when necessary.          |
| `status-footer`           | Replaces the footer with cwd, usage, context, model, thinking, and extension status info.               |
| `transcribe`              | Adds local speech-to-text dictation, a live recording meter, and `/transcribe` settings.                |

### Codex web tools

See [Codex web tools](docs/codex-web-search.md) for access modes, batching, optional conversation context, structured Codemode results, safety limits, and experimental media support. Context sharing is off by default; start Pi with `--web-search-context` to opt in.

### Development

Run `npm run check` for TypeScript validation and `npm test` for the web-tool regression suite.
