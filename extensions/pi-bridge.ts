// Last verified working with Pi v0.74.0
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BRIDGE_DIR = path.join(os.homedir(), ".pi", "agent", "bridge");
const REGISTRY_FILE = path.join(BRIDGE_DIR, "registry.json");
const HEARTBEAT_MS = 5_000;
const POLL_MS = 1_000;
const STALE_MS = 30_000;

type Peer = {
	name: string;
	displayName?: string;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	pid: number;
	updatedAt: number;
};

type BridgeEnvelope = {
	id: string;
	from: string;
	fromSessionId?: string;
	to: string;
	kind: "message" | "summary";
	text: string;
	createdAt: number;
	cwd?: string;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const ensureBridgeDir = () => fs.mkdirSync(BRIDGE_DIR, { recursive: true });

const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_");
const inboxFile = (peerName: string) => path.join(BRIDGE_DIR, `${safeName(peerName)}.jsonl`);
const now = () => Date.now();
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const readRegistry = (): Record<string, Peer> => {
	ensureBridgeDir();
	try {
		return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
	} catch {
		return {};
	}
};

const writeRegistry = (registry: Record<string, Peer>) => {
	ensureBridgeDir();
	fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
};

const upsertPeer = (peer: Peer) => {
	const registry = readRegistry();
	registry[peer.name] = peer;
	writeRegistry(registry);
};

const listPeers = () => {
	const registry = readRegistry();
	return Object.values(registry).sort((a, b) => a.name.localeCompare(b.name));
};

const readDisplayNameFromSessionFile = (sessionFile?: string): string | undefined => {
	if (!sessionFile) return undefined;
	try {
		const lines = fs.readFileSync(sessionFile, "utf8").trim().split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const entry = JSON.parse(lines[i]);
			if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
				return entry.name.trim();
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
};

const getLatestAlias = (ctx: ExtensionContext): string | undefined => {
	for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
		if (entry.type === "custom" && (entry as any).customType === "pi-bridge") {
			const name = (entry as any).data?.name;
			if (typeof name === "string" && name.trim()) return name.trim();
		}
	}
	return undefined;
};

const getDisplayName = (ctx: ExtensionContext): string => {
	const sessionName = ctx.sessionManager.getSessionName?.();
	if (sessionName?.trim()) return sessionName.trim();
	return path.basename(ctx.cwd || "session") || "session";
};

const defaultName = (ctx: ExtensionContext): string => {
	const sessionId = ctx.sessionManager.getSessionId?.();
	const cwdName = safeName(path.basename(ctx.cwd || "session") || "session");
	if (sessionId) return `${cwdName}-${sessionId.slice(0, 8)}`;
	return `${cwdName}-${process.pid}`;
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as any;
		if (block.type === "text" && typeof block.text === "string") out.push(block.text);
		if (block.type === "toolCall" && typeof block.name === "string") {
			out.push(`[tool call: ${block.name} ${JSON.stringify(block.arguments ?? {})}]`);
		}
	}
	return out;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (!["user", "assistant", "toolResult", "bashExecution", "custom"].includes(role)) continue;
		const text = extractTextParts(entry.message.content).join("\n").trim();
		if (text) sections.push(`${role.toUpperCase()}: ${text}`);
	}
	return sections.join("\n\n");
};

const fallbackSummary = (conversation: string) => {
	const trimmed = conversation.trim();
	if (trimmed.length <= 12_000) return trimmed;
	return `${trimmed.slice(0, 4_000)}\n\n...[conversation truncated]...\n\n${trimmed.slice(-8_000)}`;
};

const summarizeBranch = async (ctx: ExtensionContext, instructions?: string): Promise<string> => {
	const conversation = buildConversationText(ctx.sessionManager.getBranch() as any);
	if (!conversation.trim()) return "There is no conversation content to summarize.";

	const model = (ctx as any).model;
	if (!model) return fallbackSummary(conversation);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return fallbackSummary(conversation);

	const prompt = [
		"Summarize this Pi session so its context can be handed off to another existing Pi session.",
		"Include: goal, important decisions, files touched/read if mentioned, current state, open issues, and next steps.",
		"Be concrete and actionable. Respond in English.",
		instructions ? `Extra instructions: ${instructions}` : "",
		"",
		"<conversation>",
		conversation.slice(-120_000),
		"</conversation>",
	].filter(Boolean).join("\n");

	try {
		const response = await complete(
			model,
			{ messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }] },
			{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "medium" as any },
		);
		const text = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
		return text || fallbackSummary(conversation);
	} catch {
		return fallbackSummary(conversation);
	}
};

const parseTargetAndText = (args: string) => {
	const trimmed = args.trim();
	const match = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
	if (!match) return undefined;
	return { target: match[1], text: match[2] };
};

const pickPeer = async (ctx: ExtensionContext, title: string, excludeName: string): Promise<string | undefined> => {
	const peers = listPeers().filter((p) => p.name !== excludeName && now() - p.updatedAt < STALE_MS);
	if (peers.length === 0) {
		if (ctx.hasUI) ctx.ui.notify("No other live Pi sessions are available", "warning");
		return undefined;
	}
	if (peers.length === 1) return peers[0].name;
	if (!ctx.hasUI) return peers[0].name;
	const choices = peers.map((p) => {
		const label = readDisplayNameFromSessionFile(p.sessionFile) || p.displayName || p.name;
		const location = p.cwd ? path.basename(p.cwd) : "unknown cwd";
		const id = p.sessionId ? p.sessionId.slice(0, 8) : p.name;
		return `${label}  (${location}, ${id})`;
	});
	const choice = await ctx.ui.select(title, choices);
	if (!choice) return undefined;
	const index = choices.indexOf(choice);
	return index >= 0 ? peers[index].name : undefined;
};

export default function (pi: ExtensionAPI) {
	let currentName = `pi-${process.pid}`;
	let latestCtx: ExtensionContext | undefined;
	let inboxOffset = 0;
	let heartbeat: NodeJS.Timeout | undefined;
	let poller: NodeJS.Timeout | undefined;
	const seen = new Set<string>();

	const registerSelf = () => {
		if (!latestCtx) return;
		upsertPeer({
			name: currentName,
			displayName: getDisplayName(latestCtx),
			sessionId: latestCtx.sessionManager.getSessionId?.(),
			sessionFile: latestCtx.sessionManager.getSessionFile?.(),
			cwd: latestCtx.cwd,
			pid: process.pid,
			updatedAt: now(),
		});
	};

	const sendToPeer = (target: string, kind: BridgeEnvelope["kind"], text: string) => {
		ensureBridgeDir();
		const envelope: BridgeEnvelope = {
			id: newId(),
			from: currentName,
			fromSessionId: latestCtx?.sessionManager.getSessionId?.(),
			to: target,
			kind,
			text,
			createdAt: now(),
			cwd: latestCtx?.cwd,
		};
		fs.appendFileSync(inboxFile(target), `${JSON.stringify(envelope)}\n`);
	};

	const receiveEnvelope = (env: BridgeEnvelope) => {
		if (seen.has(env.id)) return;
		seen.add(env.id);
		const label = env.kind === "summary" ? "Summary" : "Message";
		const prompt = `${label} received from Pi session "${env.from}":\n\n${env.text}`;

		try {
			if (latestCtx?.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}
		} catch {
			// If anything fails during streaming, retry as a follow-up.
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
	};

	const pollInbox = () => {
		const file = inboxFile(currentName);
		try {
			if (!fs.existsSync(file)) return;
			const stat = fs.statSync(file);
			if (stat.size < inboxOffset) inboxOffset = 0;
			if (stat.size === inboxOffset) return;
			const fd = fs.openSync(file, "r");
			const len = stat.size - inboxOffset;
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, inboxOffset);
			fs.closeSync(fd);
			inboxOffset = stat.size;
			for (const line of buf.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const env = JSON.parse(line) as BridgeEnvelope;
					if (env.to === currentName) receiveEnvelope(env);
				} catch {
					// ignore malformed lines
				}
			}
		} catch {
			// ignore transient file errors
		}
	};

	const restartRuntime = () => {
		ensureBridgeDir();
		const file = inboxFile(currentName);
		if (!fs.existsSync(file)) fs.writeFileSync(file, "");
		// Live communication: do not reprocess old messages on startup/reload.
		inboxOffset = fs.statSync(file).size;
		registerSelf();
		if (heartbeat) clearInterval(heartbeat);
		if (poller) clearInterval(poller);
		heartbeat = setInterval(registerSelf, HEARTBEAT_MS);
		poller = setInterval(pollInbox, POLL_MS);
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		currentName = getLatestAlias(ctx) ?? defaultName(ctx);
		restartRuntime();
		if (ctx.hasUI) ctx.ui.setStatus("pi-bridge", currentName);
	});

	pi.on("session_shutdown", async () => {
		if (heartbeat) clearInterval(heartbeat);
		if (poller) clearInterval(poller);
		heartbeat = undefined;
		poller = undefined;
	});

	pi.registerCommand("bridge-name", {
		description: "Set the visible name for this session in pi-bridge",
		handler: async (args, ctx) => {
			const name = safeName(args.trim());
			if (!name) {
				ctx.ui.notify(`Current bridge name: ${currentName}`, "info");
				return;
			}
			currentName = name;
			latestCtx = ctx;
			pi.appendEntry("pi-bridge", { name });
			restartRuntime();
			ctx.ui.setStatus("pi-bridge", currentName);
			ctx.ui.notify(`pi-bridge is ready as "${currentName}"`, "success");
		},
	});

	pi.registerCommand("send", {
		description: "Send a message to another Pi session. Usage: /send [name] <message>",
		handler: async (args, ctx) => {
			let target: string | undefined;
			let text: string;
			const parsed = parseTargetAndText(args);
			if (parsed && readRegistry()[parsed.target]) {
				target = parsed.target;
				text = parsed.text;
			} else {
				target = await pickPeer(ctx, "Send message to:", currentName);
				text = args.trim();
			}
			if (!target || !text) {
				ctx.ui.notify("Usage: /send [name] <message>", "warning");
				return;
			}
			sendToPeer(target, "message", text);
			ctx.ui.notify(`Message sent to ${target}`, "success");
		},
	});

	pi.registerCommand("handoff", {
		description: "Summarize this session and send the summary to another Pi session. Usage: /handoff [name] [instructions]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const parts = trimmed ? trimmed.split(/\s+/) : [];
			let target: string | undefined;
			let instructions = "";
			if (parts[0] && readRegistry()[parts[0]]) {
				target = parts[0];
				instructions = parts.slice(1).join(" ");
			} else {
				target = await pickPeer(ctx, "Send summary to:", currentName);
				instructions = trimmed;
			}
			if (!target) return;
			ctx.ui.notify("Generating pi-bridge summary...", "info");
			const summary = await summarizeBranch(ctx, instructions);
			sendToPeer(target, "summary", summary);
			ctx.ui.notify(`Summary sent to ${target}`, "success");
		},
	});
}
