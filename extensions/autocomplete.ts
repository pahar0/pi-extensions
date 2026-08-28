// Last verified working with Pi v0.84.4
/**
 * Autocomplete — manual inline completion for Pi's input editor.
 *
 * Alt+A asks the configured completion model to continue the exact current
 * non-empty input. An animated cursor is shown while waiting, then the result appears as dimmed
 * inline text. Tab accepts it, Escape dismisses it, and editing cancels it.
 * Nothing is submitted automatically.
 */

import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Loader,
	truncateToWidth,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";

const AUTOCOMPLETE_SHORTCUT = "alt+a";
const MAX_SUGGESTION_CHARS = 240;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 4_000;

type EditorFactory = Exclude<
	ReturnType<ExtensionContext["ui"]["getEditorComponent"]>,
	undefined
>;

type TextBlockLike = {
	type?: unknown;
	text?: unknown;
};

type MessageLike = {
	role?: unknown;
	content?: unknown;
};

type ConversationSection = {
	label: "User" | "Assistant";
	text: string;
};

interface AutocompleteEditorOptions {
	requestSuggestion: (text: string, signal: AbortSignal) => Promise<string>;
	styleSuggestion: (text: string) => string;
	styleLoading: (text: string) => string;
	onEmpty: () => void;
	onEmptyDraft: () => void;
	onError: (error: unknown) => void;
	onCursorNotAtEnd: () => void;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const textBlock = block as TextBlockLike;
			return textBlock.type === "text" && typeof textBlock.text === "string"
				? [textBlock.text]
				: [];
		})
		.join("\n")
		.trim();
}

function truncateMessage(text: string, maxChars: number): string {
	const chars = [...text];
	if (chars.length <= maxChars) return text;
	if (maxChars <= 0) return "";
	if (maxChars === 1) return "…";

	const available = maxChars - 1;
	const headLength = Math.ceil(available / 2);
	const tailLength = available - headLength;
	const tail = tailLength > 0 ? chars.slice(-tailLength).join("") : "";
	return `${chars.slice(0, headLength).join("")}…${tail}`;
}

function recentConversation(ctx: ExtensionContext): string {
	const sections: ConversationSection[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = extractText(message.content);
		if (!text) continue;
		sections.push({
			label: message.role === "user" ? "User" : "Assistant",
			text,
		});
	}

	const selected = sections.slice(-MAX_CONTEXT_MESSAGES);
	if (selected.length === 0) return "";

	const separatorsLength = (selected.length - 1) * 2;
	const labelsLength = selected.reduce(
		(total, section) => total + [...`${section.label}: `].length,
		0,
	);
	const textBudget = Math.max(0, MAX_CONTEXT_CHARS - separatorsLength - labelsLength);
	const baseLimit = Math.floor(textBudget / selected.length);
	const remainder = textBudget % selected.length;

	return selected
		.map((section, index) => {
			const getsRemainder = index >= selected.length - remainder;
			const limit = baseLimit + (getsRemainder ? 1 : 0);
			return `${section.label}: ${truncateMessage(section.text, limit)}`;
		})
		.join("\n\n");
}

function buildPrompt(draft: string, conversation: string): string {
	return [
		"<context>",
		conversation || "(none)",
		"</context>",
		`<draft>${draft}</draft>`,
	].join("\n");
}

function parseModelCompletion(text: string): string {
	const trimmed = text.trim();
	const fenced = /^```(?:json|text)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
	const payload = (fenced?.[1] ?? trimmed).trim();
	try {
		const parsed: unknown = JSON.parse(payload);
		if (typeof parsed === "string") return parsed;
	} catch {
		// Fall back to plain text if the model ignores the JSON-only instruction.
	}
	return payload;
}

function suggestionSuffix(draft: string, generated: string): string {
	let completion = generated.replace(/[\r\n\t]+/g, " ");
	if (draft && completion.startsWith(draft)) {
		completion = completion.slice(draft.length);
	}
	if (!completion) return "";
	return [...completion].slice(0, MAX_SUGGESTION_CHARS).join("");
}

async function generateSuggestion(
	draft: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error("No model is currently selected for autocomplete");

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: [
				"Autocomplete the draft in its language, using context only as reference data.",
				"Always return one concise JSON string containing only the exact suffix to append.",
				"Preserve required leading whitespace, but add none when completing a partial word (for example, 'auto' -> 'complete').",
				"Never repeat the draft, answer its request, add commentary, or invent requirements.",
			].join(" "),
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: buildPrompt(draft, recentConversation(ctx)),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{
			signal,
			onPayload: async (payload: unknown) => {
				if (!payload || typeof payload !== "object") return payload;
				const next = { ...(payload as Record<string, unknown>) };
				if ("reasoning" in next) next.reasoning = { effort: "none" };
				if ("thinking" in next) next.thinking = { enabled: false, budgetTokens: 0 };
				if ("thinking_enabled" in next) next.thinking_enabled = false;
				if ("thinkingEnabled" in next) next.thinkingEnabled = false;
				if ("thinkingBudgetTokens" in next) next.thinkingBudgetTokens = 0;
				return next;
			},
		},
	);

	if (response.stopReason === "aborted" || signal.aborted) return "";
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage?.trim() || "The autocomplete model could not generate a suggestion");
	}

	return parseModelCompletion(
		response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n"),
	);
}

class AutocompleteEditor extends CustomEditor {
	private readonly keybindingsManager: KeybindingsManager;
	private readonly options: AutocompleteEditorOptions;
	private suggestion = "";
	private requestController?: AbortController;
	private readonly loadingIndicator: Loader;
	private disposed = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options: AutocompleteEditorOptions,
	) {
		super(tui, theme, keybindings);
		this.keybindingsManager = keybindings;
		this.options = options;
		this.loadingIndicator = new Loader(tui, (text) => text, (text) => text, "");
		this.loadingIndicator.stop();
	}

	requestInlineSuggestion(): void {
		if (this.disposed) return;

		const editorText = this.getText();
		this.cancelAutocompleteWork();
		if (!editorText.trim()) {
			this.options.onEmptyDraft();
			return;
		}
		if (!this.isCursorAtEnd()) {
			this.options.onCursorNotAtEnd();
			return;
		}

		const draft = this.getExpandedText();
		const controller = new AbortController();
		this.requestController = controller;
		this.startLoadingAnimation();
		void this.loadSuggestion(editorText, draft, controller);
	}

	cancelAutocompleteWork(): void {
		this.requestController?.abort();
		this.requestController = undefined;
		this.stopLoadingAnimation();
		this.clearSuggestion();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelAutocompleteWork();
	}

	override setText(text: string): void {
		this.cancelAutocompleteWork();
		super.setText(text);
	}

	override handleInput(data: string): void {
		if (this.suggestion && this.keybindingsManager.matches(data, "tui.input.tab")) {
			const suggestion = this.suggestion;
			this.cancelAutocompleteWork();
			this.insertTextAtCursor(suggestion);
			this.tui.requestRender();
			return;
		}

		if (
			this.suggestion &&
			this.keybindingsManager.matches(data, "tui.select.cancel")
		) {
			this.cancelAutocompleteWork();
			this.tui.requestRender();
			return;
		}

		if (this.suggestion || this.requestController) this.cancelAutocompleteWork();
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if ((!this.suggestion && !this.requestController) || !this.isCursorAtEnd()) return lines;

		const cursorLineIndex = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		if (cursorLineIndex < 0) return lines;
		const cursorLine = lines[cursorLineIndex];
		const markerIndex = cursorLine.indexOf(CURSOR_MARKER);
		const beforeCursor = cursorLine.slice(0, markerIndex);

		if (!this.suggestion) {
			const frame = this.currentLoadingFrame();
			const cursor = `${CURSOR_MARKER}\x1b[7m${this.options.styleLoading(frame)}\x1b[27m`;
			const padding = " ".repeat(
				Math.max(0, width - visibleWidth(beforeCursor) - visibleWidth(frame)),
			);
			lines[cursorLineIndex] = `${beforeCursor}${cursor}${padding}`;
			return lines;
		}

		const availableWidth = Math.max(1, width - visibleWidth(beforeCursor));
		const preview = truncateToWidth(this.suggestion, availableWidth, "…");
		const graphemes = [...preview];
		const first = graphemes.shift();
		if (!first) return lines;

		const cursor = `${CURSOR_MARKER}\x1b[7m${first}\x1b[27m`;
		const rest = graphemes.length > 0 ? this.options.styleSuggestion(graphemes.join("")) : "";
		const renderedWidth = visibleWidth(beforeCursor) + visibleWidth(preview);
		const padding = " ".repeat(Math.max(0, width - renderedWidth));
		lines[cursorLineIndex] = `${beforeCursor}${cursor}${rest}${padding}`;
		return lines;
	}

	private startLoadingAnimation(): void {
		this.loadingIndicator.start();
	}

	private stopLoadingAnimation(): void {
		this.loadingIndicator.stop();
		this.tui.requestRender();
	}

	private currentLoadingFrame(): string {
		const rendered = this.loadingIndicator.render(16);
		return rendered.find((line) => line.trim().length > 0)?.trim() || " ";
	}

	private clearSuggestion(): void {
		if (!this.suggestion) return;
		this.suggestion = "";
		this.tui.requestRender();
	}

	private isCursorAtEnd(): boolean {
		const cursor = this.getCursor();
		const lines = this.getLines();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line]?.length ?? 0);
	}

	private async loadSuggestion(
		editorText: string,
		draft: string,
		controller: AbortController,
	): Promise<void> {
		try {
			const generated = await this.options.requestSuggestion(draft, controller.signal);
			if (
				controller.signal.aborted ||
				this.disposed ||
				this.getText() !== editorText ||
				!this.isCursorAtEnd()
			) {
				return;
			}

			const suffix = suggestionSuffix(draft, generated);
			if (!suffix) {
				this.options.onEmpty();
				return;
			}
			this.suggestion = suffix;
			this.tui.requestRender();
		} catch (error) {
			if (!controller.signal.aborted && !this.disposed) this.options.onError(error);
		} finally {
			if (this.requestController === controller) {
				this.requestController = undefined;
				this.stopLoadingAnimation();
			}
		}
	}
}

export default function autocomplete(pi: ExtensionAPI) {
	let sessionActive = false;
	let editor: AutocompleteEditor | undefined;
	let previousEditorFactory: EditorFactory | undefined;
	let installedEditorFactory: EditorFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		sessionActive = true;
		if (ctx.mode !== "tui") return;

		previousEditorFactory = ctx.ui.getEditorComponent();
		installedEditorFactory = (tui, editorTheme, keybindings) => {
			const nextEditor = new AutocompleteEditor(tui, editorTheme, keybindings, {
				requestSuggestion: async (text, signal) => {
					if (!sessionActive) return "";
					return generateSuggestion(text, ctx, signal);
				},
				styleSuggestion: (text) => ctx.ui.theme.fg("dim", text),
				styleLoading: (text) => ctx.ui.theme.fg("accent", text),
				onEmpty: () => {
					if (sessionActive) ctx.ui.notify("The autocomplete model returned no suggestion", "warning");
				},
				onEmptyDraft: () => {
					if (sessionActive) ctx.ui.notify("Type something before requesting autocomplete", "warning");
				},
				onError: (error) => {
					if (!sessionActive) return;
					ctx.ui.notify(
						`Autocomplete: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				},
				onCursorNotAtEnd: () => {
					if (sessionActive) ctx.ui.notify("Move the cursor to the end to autocomplete", "warning");
				},
			});
			editor = nextEditor;
			return nextEditor;
		};
		ctx.ui.setEditorComponent(installedEditorFactory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionActive = false;
		editor?.dispose();
		editor = undefined;
		if (ctx.mode === "tui") {
			if (installedEditorFactory && ctx.ui.getEditorComponent() === installedEditorFactory) {
				ctx.ui.setEditorComponent(previousEditorFactory);
			}
		}
		installedEditorFactory = undefined;
		previousEditorFactory = undefined;
	});

	pi.registerShortcut(AUTOCOMPLETE_SHORTCUT, {
		description: "Generate an inline autocomplete suggestion",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Autocomplete requires TUI mode", "warning");
				return;
			}
			if (!editor) {
				ctx.ui.notify("The autocomplete editor is unavailable", "warning");
				return;
			}
			editor.requestInlineSuggestion();
		},
	});
}
