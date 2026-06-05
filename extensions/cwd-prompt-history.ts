// Last verified working with Pi v0.78.1
import { CustomEditor, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type UserMessage = {
	role?: string;
	content?: unknown;
};

type SessionEntry = {
	type?: string;
	message?: UserMessage;
};

function extractUserText(message: UserMessage | undefined): string {
	if (!message || message.role !== "user") return "";

	if (typeof message.content === "string") {
		return message.content.trim();
	}

	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter((block): block is { type?: string; text?: unknown } => !!block && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

async function loadPreviousUserMessages(cwd: string, currentSessionFile?: string): Promise<string[]> {
	const sessions = await SessionManager.list(cwd);
	const priorSessions = sessions
		.filter((session) => session.path !== currentSessionFile)
		.sort((a, b) => a.modified.getTime() - b.modified.getTime());

	const messages: string[] = [];

	for (const session of priorSessions) {
		try {
			const manager = SessionManager.open(session.path);
			for (const entry of manager.getEntries() as SessionEntry[]) {
				if (entry.type !== "message") continue;
				const text = extractUserText(entry.message);
				if (text) messages.push(text);
			}
		} catch {
			// Ignore unreadable/corrupt sessions and keep going.
		}
	}

	return messages;
}

class CwdHistoryEditor extends CustomEditor {
	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		historyTexts: string[],
	) {
		super(tui, theme, keybindings);

		for (const text of historyTexts) {
			this.addToHistory(text);
		}
	}
}

function addHistory(editor: { addToHistory?: (text: string) => void }, historyTexts: string[]): boolean {
	if (!editor.addToHistory) return false;
	for (const text of historyTexts) {
		editor.addToHistory(text);
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const currentSessionFile = ctx.sessionManager.getSessionFile();
		const previousMessages = await loadPreviousUserMessages(ctx.cwd, currentSessionFile);
		const previousEditorFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			if (previousEditorFactory) {
				const editor = previousEditorFactory(tui, theme, keybindings);
				if (!addHistory(editor, previousMessages)) {
					ctx.ui.notify("cwd-prompt-history: current custom editor does not support history injection", "warning");
				}
				return editor;
			}

			return new CwdHistoryEditor(tui, theme, keybindings, previousMessages);
		});
	});
}
