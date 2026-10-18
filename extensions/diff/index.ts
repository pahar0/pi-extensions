// Last verified with Pi v1.3.0.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { collectSnapshot } from "./git.ts";
import { DRAFT_TYPE, restoreDraft, type Draft } from "./model.ts";
import { DiffReviewScreen } from "./ui.ts";

/** Treat the command's entire remainder as one path, never as shell syntax. */
function reviewPath(args: string, cwd: string): string {
  let path = args.trim();
  if (!path) return cwd;
  const quote = path[0];
  if (quote === '"' || quote === "'") {
    if (path.length < 2 || path.at(-1) !== quote) throw new Error("Usage: /diff [path] — close the quoted path.");
    path = path.slice(1, -1);
  }
  if (!path || path.includes("\0")) throw new Error("Usage: /diff [path] — provide a non-empty file or directory path.");
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

export default function diffExtension(pi: ExtensionAPI): void {
  let open = false;
  pi.registerCommand("diff", {
    description: "Review Git changes for [path] (default: cwd), annotate, and send feedback to Pi",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/diff needs Pi's interactive terminal UI.", "warning");
        return;
      }
      if (open) return;
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for Pi to finish before reviewing, so files do not change underneath you.", "warning");
        return;
      }
      open = true;
      try {
        const snapshot = await collectSnapshot(reviewPath(args, ctx.cwd));
        if (!snapshot.files.length) {
          ctx.ui.notify(`No changes for ${JSON.stringify(snapshot.target)}.`, "info");
          return;
        }
        const annotations = restoreDraft(ctx.sessionManager.getBranch(), snapshot.root, snapshot.scope);
        const save = (notes: typeof annotations) => pi.appendEntry<Draft>(DRAFT_TYPE, {
          version: 1, root: snapshot.root, scope: snapshot.scope, annotations: notes,
        });
        const prompt = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
          new DiffReviewScreen(tui, theme, keybindings, {
            snapshot, annotations, onChange: save, onDone: done,
          }), {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "top-left" },
        });
        if (prompt === undefined) return;
        if (!ctx.isIdle()) {
          ctx.ui.notify("Pi became busy. Your notes are saved; reopen /diff to submit when it is idle.", "warning");
          return;
        }
        pi.sendUserMessage(prompt);
        // Clear only after the runtime accepts the message. Failures retain drafts.
        save([]);
      } catch (error) {
        ctx.ui.notify(`/diff: ${(error as Error).message}`, "error");
      } finally {
        open = false;
      }
    },
  });
}
