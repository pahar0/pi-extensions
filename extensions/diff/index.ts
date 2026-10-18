// Last verified with Pi v1.3.0.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectReview } from "./git.ts";
import { DRAFT_TYPE, restoreReviewDraft, reviewDraft, reviewSources, type Annotation } from "./model.ts";
import { reviewPaths } from "./paths.ts";
import { DiffReviewScreen } from "./ui.ts";

export default function diffExtension(pi: ExtensionAPI): void {
  let open = false;
  pi.registerCommand("diff", {
    description: "Review Git changes for [paths...] across repositories (default: cwd) and send annotated feedback to Pi",
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
        const snapshot = await collectReview(reviewPaths(args, ctx.cwd));
        if (!snapshot.files.length) {
          const targets = reviewSources(snapshot).map((source) => JSON.stringify(source.target)).join(", ");
          ctx.ui.notify(`No changes for ${targets}.`, "info");
          return;
        }
        const annotations = restoreReviewDraft(ctx.sessionManager.getBranch(), snapshot);
        const save = (notes: Annotation[]) => pi.appendEntry(DRAFT_TYPE, reviewDraft(snapshot, notes));
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
