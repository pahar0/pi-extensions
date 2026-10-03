// Last verified working with Pi v1.0.1
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type ModelLike = Model<Api>;

type UsageLike = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

type SessionEntryLike = {
	type: string;
	message?: { role?: string; usage?: UsageLike };
	usage?: UsageLike;
};

type FooterThemeLike = {
	fg: (token: ThemeColor, text: string) => string;
};

type FooterDataLike = {
	onBranchChange: (listener: () => void) => () => void;
	getExtensionStatuses: () => ReadonlyMap<string, string>;
};

type FooterContextLike = {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	cwd?: string;
	model?: ModelLike;
	modelRegistry: {
		getProvider: (provider: string) => Provider | undefined;
		isUsingOAuth: (model: ModelLike) => boolean;
	};
	sessionManager: {
		getEntries: () => SessionEntryLike[];
		getEntryCount?: () => number;
		getLeafId: () => string | null;
		getSessionId: () => string;
		getSessionName?: () => string | undefined;
	};
	getContextUsage: () => { contextWindow?: number; percent: number | null } | null | undefined;
};

export default function statusFooter(pi: ExtensionAPI) {

	function formatTokens(n: number): string {
		return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
	}

	function formatCwd(path: string): string {
		if (!path) return "";
		const home = homedir();
		return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
	}

	function compactCwd(path: string, maxWidth: number): string {
		const formatted = formatCwd(path);
		if (!formatted || maxWidth <= 0) return "";
		if (visibleWidth(formatted) <= maxWidth) return formatted;

		const prefix = formatted.startsWith("~/") ? "~/" : formatted.startsWith("/") ? "/" : "";
		const body = formatted.slice(prefix.length);
		const parts = body.split("/").filter(Boolean);
		const marker = `${prefix}…/`;
		const available = maxWidth - visibleWidth(marker);

		if (parts.length === 0 || available < 4) return truncateToWidth(formatted, maxWidth);

		let suffix = "";
		for (let i = parts.length - 1; i >= 0; i--) {
			const candidate = suffix ? `${parts[i]}/${suffix}` : parts[i];
			if (visibleWidth(candidate) > available) break;
			suffix = candidate;
		}

		if (!suffix) suffix = truncateToWidth(parts[parts.length - 1], available);
		return `${marker}${suffix}`;
	}

	function currentModelLabel(ctx: FooterContextLike): string {
		const model = ctx?.model;
		return model?.id || model?.name || "";
	}

	function sanitizeStatusText(text: string): string {
		return text.replace(/[\r\n]+/g, " ");
	}

	function currentSessionName(ctx: FooterContextLike): string {
		return sanitizeStatusText(ctx.sessionManager.getSessionName?.() ?? "").trim();
	}

	function getEntryUsage(entry: SessionEntryLike): UsageLike | undefined {
		if (
			entry.type === "message" &&
			(entry.message?.role === "assistant" || entry.message?.role === "toolResult")
		) {
			return entry.message.usage;
		}
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
			return entry.usage;
		}
		return undefined;
	}

	function rightLabel(ctx: FooterContextLike, theme: FooterThemeLike, footerData: FooterDataLike): string {
		const liveModelLabel = currentModelLabel(ctx);
		const thinkingValue =
			pi.getThinkingLevel?.() === "off"
				? theme.fg("dim", "off")
				: theme.fg("warning", String(pi.getThinkingLevel?.() ?? "off"));
		const extensionStatuses = Array.from(footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.filter((text) => text.length > 0)
			.join(` ${theme.fg("dim", "•")} `);
		const parts = [
			liveModelLabel ? `${theme.fg("dim", liveModelLabel)} ${theme.fg("dim", "(ctrl+p)")}` : "",
			`${thinkingValue} ${theme.fg("dim", "(shift+tab)")}`,
			extensionStatuses,
		].filter(Boolean);
		return parts.join(` ${theme.fg("dim", "•")} `);
	}

	function fitThreeColumns(left: string, middle: string, right: string, width: number): string {
		const clamp = (line: string) => truncateToWidth(line, width);
		const lw = visibleWidth(left);
		const mw = visibleWidth(middle);
		const rw = visibleWidth(right);

		if (lw + mw + rw <= width) {
			const remaining = width - lw - mw - rw;
			const leftPad = Math.max(0, Math.floor(remaining / 2));
			const rightPad = Math.max(0, remaining - leftPad);
			return clamp(left + " ".repeat(leftPad) + middle + " ".repeat(rightPad) + right);
		}

		if (lw + rw + 2 <= width) {
			const availableForMiddle = Math.max(0, width - lw - rw - 2);
			const mid = availableForMiddle > 0 ? truncateToWidth(middle, availableForMiddle) : "";
			const midw = visibleWidth(mid);
			const remaining = width - lw - midw - rw;
			const leftPad = Math.max(0, Math.floor(remaining / 2));
			const rightPad = Math.max(0, remaining - leftPad);
			return clamp(left + " ".repeat(leftPad) + mid + " ".repeat(rightPad) + right);
		}

		const availableForRight = Math.max(0, width - lw - 1);
		const truncatedRight = availableForRight > 0 ? truncateToWidth(right, availableForRight) : "";
		if (!truncatedRight) return clamp(left);
		const pad = Math.max(1, width - lw - visibleWidth(truncatedRight));
		return clamp(left + " ".repeat(pad) + truncatedRight);
	}

	function ansi256(color: number, text: string): string {
		return `\x1b[38;5;${color}m${text}\x1b[0m`;
	}

	function colorContextPercent(percentWithSymbol: string, percentValue: number, theme: FooterThemeLike): string {
		if (percentWithSymbol === "?") return theme.fg("dim", percentWithSymbol);
		if (percentValue >= 90) return theme.fg("error", percentWithSymbol);
		if (percentValue >= 85) return ansi256(202, percentWithSymbol); // orange-red: urgent, compact now
		if (percentValue >= 75) return ansi256(208, percentWithSymbol); // yellow-orange: compact suggested
		if (percentValue >= 70) return ansi256(214, percentWithSymbol); // soft warning
		return theme.fg("dim", percentWithSymbol);
	}

	type SessionStats = {
		totalInput: number;
		totalOutput: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalCost: number;
		latestCacheHitRate?: number;
		contextUsage: ReturnType<FooterContextLike["getContextUsage"]>;
	};

	type CachedSessionStats = SessionStats & {
		sessionId: string;
		leafId: string | null;
		entryCount: number;
		model: ModelLike | undefined;
	};

	function calculateSessionStats(ctx: FooterContextLike): SessionStats {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;
		let latestCacheHitRate: number | undefined;

		for (const entry of ctx.sessionManager.getEntries()) {
			const usage = getEntryUsage(entry);
			if (!usage) continue;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
			if (entry.type === "message" && entry.message?.role === "assistant") {
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				latestCacheHitRate = promptTokens > 0
					? (usage.cacheRead / promptTokens) * 100
					: undefined;
			}
		}

		return {
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			latestCacheHitRate,
			contextUsage: ctx.getContextUsage(),
		};
	}

	function createSessionStatsGetter(ctx: FooterContextLike): () => SessionStats {
		let cached: CachedSessionStats | undefined;

		return () => {
			const entryCount = ctx.sessionManager.getEntryCount?.();
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			const model = ctx.model;

			if (
				entryCount !== undefined &&
				cached?.sessionId === sessionId &&
				cached.leafId === leafId &&
				cached.entryCount === entryCount &&
				cached.model === model
			) {
				return cached;
			}

			const stats = calculateSessionStats(ctx);
			cached = entryCount === undefined
				? undefined
				: { ...stats, sessionId, leafId, entryCount, model };
			return stats;
		};
	}

	function middleLabel(ctx: FooterContextLike, theme: FooterThemeLike, stats: SessionStats): string {
		const {
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			latestCacheHitRate,
			contextUsage,
		} = stats;
		const parts: string[] = [];
		if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);
		if ((totalCacheRead || totalCacheWrite) && latestCacheHitRate !== undefined) {
			parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		const usingSubscription = ctx.model
			? ctx.model.provider === "kimi-coding" ||
				(ctx.modelRegistry.isUsingOAuth(ctx.model) &&
					ctx.modelRegistry.getProvider(ctx.model.provider)?.auth.oauth?.isSubscription === true)
			: false;
		if (totalCost || usingSubscription) {
			parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const contextWindowDisplay = formatTokens(contextWindow);
		const contextStr =
			contextPercent === "?"
				? `${colorContextPercent(contextPercent, contextPercentValue, theme)}${theme.fg("dim", `/${contextWindowDisplay}`)}`
				: `${colorContextPercent(`${contextPercent}%`, contextPercentValue, theme)}${theme.fg("dim", `/${contextWindowDisplay}`)}`;
		parts.push(contextStr);

		return parts.map((part) => (part.includes("\x1b[") ? part : theme.fg("dim", part))).join(" ");
	}

	function installFooter(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender());
			const getSessionStats = createSessionStatsGetter(ctx);
			return {
				dispose,
				render(width: number) {
					const sessionLabel = currentSessionName(ctx);
					const cwdMaxWidth = Math.max(8, Math.min(40, Math.floor(width * 0.3)));
					const cwdLabel = compactCwd(ctx.cwd ?? "", cwdMaxWidth);
					const left = [
						sessionLabel ? theme.fg("accent", sessionLabel) : "",
						cwdLabel ? theme.fg("accent", cwdLabel) : "",
					].filter(Boolean).join(` ${theme.fg("dim", "•")} `);
					const middle = middleLabel(ctx, theme, getSessionStats());
					const right = rightLabel(ctx, theme, footerData);
					if (!left && !middle) return [truncateToWidth(right, width)];
					if (!left) return [truncateToWidth(`${middle} ${right}`.trim(), width)];
					return [fitThreeColumns(left, middle, right, width)];
				},
				invalidate() {},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (event.reason === "reload") return;
		ctx.ui.setFooter(undefined);
	});


}
