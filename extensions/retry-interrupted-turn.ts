// Last verified working with Pi v0.84.1
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const SHORTCUT = Key.ctrl("r");
const MARKER_TYPE = "retry-interrupted-turn";
const INTERRUPTED_STOP_REASONS = new Set(["aborted", "error"]);

type ContextMessage = {
	role: string;
	customType?: string;
	stopReason?: string;
};

function isInterruptedAssistant(message: ContextMessage | undefined): boolean {
	return (
		message?.role === "assistant" &&
		typeof message.stopReason === "string" &&
		INTERRUPTED_STOP_REASONS.has(message.stopReason)
	);
}

/**
 * A custom message is required to start an idle extension turn. Remove that
 * private control marker, plus the failed assistant attempt(s) it retries,
 * before every provider request. The model therefore receives the same clean
 * context that it would have received if Pi exposed Agent.continue() here.
 */
function withoutRetryMarkers<T extends ContextMessage>(messages: T[]): T[] {
	const removed = new Set<number>();

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "custom" || message.customType !== MARKER_TYPE) continue;

		removed.add(index);
		let previous = index - 1;
		while (previous >= 0 && isInterruptedAssistant(messages[previous])) {
			removed.add(previous);
			previous -= 1;
		}
	}

	return removed.size === 0 ? messages : messages.filter((_message, index) => !removed.has(index));
}

export default function retryInterruptedTurnExtension(pi: ExtensionAPI) {
	pi.on("context", (event) => {
		const messages = withoutRetryMarkers(event.messages);
		return messages === event.messages ? undefined : { messages };
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Retry the last interrupted agent turn without adding a user message",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("The agent is still running", "warning");
				return;
			}

			const contextEntries = ctx.sessionManager.buildContextEntries();
			const lastMessageEntry = contextEntries
				.slice()
				.reverse()
				.find((entry) => entry.type === "message");
			const lastMessage =
				lastMessageEntry?.type === "message"
					? (lastMessageEntry.message as ContextMessage)
					: undefined;
			if (!isInterruptedAssistant(lastMessage)) {
				ctx.ui.notify("There is no interrupted agent turn to retry", "warning");
				return;
			}

			pi.sendMessage(
				{
					customType: MARKER_TYPE,
					content: "Retry the interrupted agent turn.",
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});
}
