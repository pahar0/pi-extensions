import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SearchContextMessage, SearchInput } from "./schema.ts";

// A conservative byte cap, not a tokenizer. ASCII prose is roughly 1,000 tokens.
const ASSISTANT_CONTEXT_BYTES = 4_000;
const USER_CONTEXT_BYTES = 8_000;

export function truncateUtf8(value: string, maxBytes: number, tail = false): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	if (!tail) {
		let end = maxBytes;
		while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
		return bytes.subarray(0, end).toString("utf8");
	}
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export function recentSearchInput(ctx: ExtensionContext, fallback: string): SearchInput {
	const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) continue;
		const text = typeof message.content === "string" ? message.content : message.content
			.filter((item) => item.type === "text")
			.map((item) => item.type === "text" ? item.text : "").join("\n");
		if (!text.trim() || (message.role === "user" && /^\s*<(?:environment_context|system_reminder|user_instructions)\b/.test(text))) continue;
		messages.push({ role: message.role, text });
	}
	const userIndexes = messages.flatMap((message, index) => message.role === "user" ? [index] : []).slice(-2);
	if (userIndexes.length === 0) return fallback;
	const first = userIndexes[0]!;
	const last = userIndexes.at(-1)!;
	let assistantBytes = ASSISTANT_CONTEXT_BYTES;
	const selected: SearchContextMessage[] = [];
	// Prefer the newest assistant text. Exclude commentary after the current user.
	for (let index = last; index >= first; index--) {
		const message = messages[index]!;
		const text = message.role === "user" ? truncateUtf8(message.text, USER_CONTEXT_BYTES) : truncateUtf8(message.text, assistantBytes, true);
		if (!text) continue;
		if (message.role === "assistant") assistantBytes -= Buffer.byteLength(text);
		selected.unshift({ type: "message", role: message.role, content: [{ type: message.role === "user" ? "input_text" : "output_text", text }] });
	}
	return selected;
}

export function retryAfterDelay(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (/^\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(seconds)) return seconds * 1_000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
		const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason ?? new Error("Web request cancelled.")); };
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class PageCache<T extends { text: string }> {
	private readonly entries = new Map<string, { value: T; at: number; bytes: number }>();
	private totalBytes = 0;
	private readonly now: () => number;
	private readonly maxBytes: number;
	private readonly ttlMs: number;
	constructor(now: () => number, maxBytes = 8 * 1024 * 1024, ttlMs = 120_000) { this.now = now; this.maxBytes = maxBytes; this.ttlMs = ttlMs; }
	get(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (this.now() - entry.at >= this.ttlMs) { this.remove(key); return undefined; }
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}
	set(key: string, value: T): void {
		this.remove(key);
		const bytes = Buffer.byteLength(value.text);
		if (bytes > this.maxBytes) return;
		this.entries.set(key, { value, bytes, at: this.now() });
		this.totalBytes += bytes;
		while (this.totalBytes > this.maxBytes || this.entries.size > 16) this.remove(this.entries.keys().next().value!);
	}
	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (entry) this.totalBytes -= entry.bytes;
		this.entries.delete(key);
	}
	clear(): void { this.entries.clear(); this.totalBytes = 0; }
}
