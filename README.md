# Pi Extensions

Personal extensions for the [Pi coding agent](https://pi.dev/).

## Installation

Install globally with Pi's package manager:

```bash
pi install git:github.com/pahar0/pi-extensions
```

Pi will load the conventional `extensions/` directory from this repository as a package. If Pi is already running, use `/reload` or restart Pi after installing.

## Extensions

| Extension | Description |
| --- | --- |
| `init` | Adds `/init` to survey a repository and create or improve project guidance in `AGENTS.md`. |
| `mutation-guard` | Prompts for approval before file edits, writes, and risky shell mutations. |
| `resource-manager` | Adds commands for enabling, disabling, and uninstalling custom extensions and skills. |
| `restore-files` | Tracks file checkpoints and can restore code alongside conversation tree navigation. |
| `status-footer` | Replaces the footer with cwd, usage, context, model, thinking, and extension status info. |
