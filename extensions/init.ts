// Last verified working with Pi v0.74.0
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

function buildInitPrompt(targetPath: string): string {
  return [
    `Survey the repository at ${targetPath} and create or improve a project-level AGENTS.md for future Pi coding sessions.`,
    "",
    "Goal:",
    "Write a concise, high-signal AGENTS.md that helps a future coding agent become productive quickly and avoid repo-specific mistakes.",
    "Every line in AGENTS.md should earn its place: if removing it would not make a future agent less effective, leave it out.",
    "",
    "Process:",
    "1. Identify the actual repo root if the provided path is inside a subdirectory.",
    "2. Inspect the most informative files first.",
    "3. Infer the real workflows, architecture, and gotchas from the codebase.",
    "4. If important information cannot be inferred reliably, ask a few focused questions before writing AGENTS.md.",
    "5. Then create or improve AGENTS.md.",
    "",
    "Read these sources when present:",
    "- README.md and other top-level docs",
    "- Manifest/build files: package.json, pnpm-workspace.yaml, turbo.json, Cargo.toml, pyproject.toml, go.mod, Makefile, justfile, pom.xml, etc.",
    "- Test, lint, typecheck, formatter, and CI config",
    "- Existing AGENTS.md files",
    "- Other AI guidance files such as AGENTS.md variants, .cursor/rules, .cursorrules, .github/copilot-instructions.md, and similar repo instructions",
    "",
    "Infer and capture only the important things, such as:",
    "- The real build, test, lint, typecheck, and verification commands, especially if they are non-obvious",
    "- Repo structure or architecture that is hard to understand quickly from a shallow scan",
    "- Important workflow expectations, conventions, or review/validation habits specific to this repo",
    "- Non-obvious setup requirements, environment constraints, or gotchas",
    "- Module-specific guidance only if it truly matters; otherwise mention that subdirectory AGENTS.md files can be added later",
    "",
    "Writing rules:",
    "- Prefer short sections and bullets over long prose",
    "- Be specific and concrete",
    "- If AGENTS.md already exists, read it first and improve it instead of replacing it blindly",
    "- Preserve useful existing content, tighten weak content, and remove stale or generic content",
    "",
    "Do NOT include:",
    "- Generic software-engineering advice",
    "- Obvious language conventions or things a coding agent can easily rediscover",
    "- Long file trees, exhaustive component inventories, or documentation dumps",
    "- Vague statements like 'write clean code' or 'handle errors properly'",
    "",
    "Before writing, think carefully about what a future agent would genuinely need in this repo and what would just be noise.",
    "After writing or updating AGENTS.md, briefly summarize what you added or changed and why.",
  ].join("\n");
}

export default function initExtension(pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Survey a repo and create concise AGENTS.md guidance",
    handler: async (args, ctx) => {
      const rawTarget = args.trim();
      const targetPath = rawTarget ? resolve(ctx.cwd, rawTarget) : ctx.cwd;

      const prompt = buildInitPrompt(targetPath);
      ctx.ui.notify(`Queued /init for ${targetPath}`, "info");
      pi.sendUserMessage(prompt);
    },
  });
}
