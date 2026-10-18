// Last verified with Pi v1.3.0.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectReview } from "./git.ts";
import { DRAFT_TYPE, restoreReviewDraft, reviewDraft, reviewSources, type Annotation } from "./model.ts";
import { MAX_REVIEW_PATHS, resolveReviewPaths, reviewPaths } from "./paths.ts";
import { DiffReviewScreen } from "./ui.ts";

const ShowDiffParams = Type.Object({
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1, maxItems: MAX_REVIEW_PATHS,
    description: "File, directory, or repository paths (absolute, relative to cwd, or ~/). Defaults to the current directory.",
  })),
});

type ReviewResult =
  | { status: "unchanged" | "closed"; message: string }
  | { status: "submitted"; prompt: string; clearDraft: () => void };

export default function diffExtension(pi: ExtensionAPI): void {
  let open = false;

  const review = async (paths: string[], ctx: ExtensionContext, signal?: AbortSignal): Promise<ReviewResult> => {
    signal?.throwIfAborted();
    const snapshot = await collectReview(paths, signal);
    signal?.throwIfAborted();
    if (!snapshot.files.length) {
      const targets = reviewSources(snapshot).map((source) => JSON.stringify(source.target)).join(", ");
      return { status: "unchanged", message: `No changes for ${targets}.` };
    }
    const annotations = restoreReviewDraft(ctx.sessionManager.getBranch(), snapshot);
    const save = (notes: Annotation[]) => pi.appendEntry(DRAFT_TYPE, reviewDraft(snapshot, notes));
    let abortReview: (() => void) | undefined;
    try {
      const prompt = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
        let settled = false;
        const finish = (prompt: string | undefined) => {
          if (settled) return;
          settled = true;
          done(prompt);
        };
        const screen = new DiffReviewScreen(tui, theme, keybindings, {
          snapshot, annotations, onChange: save, onDone: finish,
        });
        abortReview = () => { screen.dispose(); finish(undefined); };
        signal?.addEventListener("abort", abortReview, { once: true });
        if (signal?.aborted) queueMicrotask(abortReview);
        return screen;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "top-left" },
      });
      signal?.throwIfAborted();
      return prompt === undefined
        ? { status: "closed", message: "Diff viewer closed without submitting feedback. Drafts retained." }
        : { status: "submitted", prompt, clearDraft: () => save([]) };
    } finally {
      if (abortReview) signal?.removeEventListener("abort", abortReview);
    }
  };

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
        const result = await review(reviewPaths(args, ctx.cwd), ctx);
        if (result.status === "unchanged") ctx.ui.notify(result.message, "info");
        if (result.status !== "submitted") return;
        if (!ctx.isIdle()) {
          ctx.ui.notify("Pi became busy. Your notes are saved; reopen /diff to submit when it is idle.", "warning");
          return;
        }
        pi.sendUserMessage(result.prompt);
        // Clear only after the runtime accepts the message. Failures retain drafts.
        result.clearDraft();
      } catch (error) {
        ctx.ui.notify(`/diff: ${(error as Error).message}`, "error");
      } finally {
        open = false;
      }
    },
  });

  pi.registerTool({
    name: "show_diff",
    label: "Show Diff",
    description: "Open the interactive Git diff viewer when the user asks to see diffs or changes. Shows uncommitted changes only. Pass file, directory, or repository paths matching the requested scope; omit paths to use the current directory.",
    promptSnippet: "Show and annotate uncommitted Git changes in an interactive viewer",
    promptGuidelines: ["When the user asks to see diffs or changes, use show_diff with paths matching the requested scope."],
    parameters: ShowDiffParams,
    exposure: "model-only",
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error("show_diff needs Pi's interactive terminal UI.");
      if (open) throw new Error("A diff review is already open.");
      open = true;
      try {
        // This tool owns the active turn; only the manual command requires idle.
        const result = await review(resolveReviewPaths(params.paths ?? [], ctx.cwd), ctx, signal);
        if (result.status === "submitted") {
          result.clearDraft();
          return { content: [{ type: "text", text: result.prompt }], details: { status: result.status } };
        }
        return { content: [{ type: "text", text: result.message }], details: { status: result.status } };
      } catch (error) {
        if (!signal?.aborted) throw error;
        return { content: [{ type: "text", text: "Diff review cancelled. Drafts retained." }], details: { status: "aborted" }, terminate: true };
      } finally {
        open = false;
      }
    },
  });
}
