// Last verified working with Pi v0.74.0
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

type ModelLike = {
	id?: string;
	name?: string;
	contextWindow?: number;
};

type AssistantUsageLike = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

type AssistantMessageLike = {
	role: "assistant";
	usage: AssistantUsageLike;
};

type SessionEntryLike =
	| {
			type: "message";
			message?: AssistantMessageLike | { role?: string; usage?: AssistantUsageLike };
	  }
	| {
			type: string;
			message?: { role?: string; usage?: AssistantUsageLike };
	  };

type FooterThemeLike = {
	fg: (token: string, text: string) => string;
};

type FooterDataLike = {
	onBranchChange: (listener: () => void) => () => void;
	getExtensionStatuses: () => Map<string, string>;
};

type FooterTuiLike = {
	requestRender: () => void;
};

type FooterContextLike = {
	hasUI?: boolean;
	cwd?: string;
	model?: ModelLike;
	modelRegistry: {
		isUsingOAuth: (model: ModelLike) => boolean;
	};
	sessionManager: {
		getEntries: () => SessionEntryLike[];
	};
	getContextUsage: () => { contextWindow?: number; percent: number | null } | null | undefined;
	ui: {
		setFooter: (
			renderer:
				| undefined
				| ((
						tui: FooterTuiLike,
						theme: FooterThemeLike,
						footerData: FooterDataLike,
					) => {
						dispose?: () => void;
						render: (width: number) => string[];
						invalidate: () => void;
					}),
		) => void;
	};
};

export default function statusWidget(pi: ExtensionAPI) {

	function formatTokens(n: number): string {
		return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
	}

	function formatCwd(path: string): string {
		if (!path) return "";
		const home = homedir();
		return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
	}

	function currentModelLabel(ctx: FooterContextLike): string {
		const model = ctx?.model;
		return model?.id || model?.name || "";
	}

	function sanitizeStatusText(text: string): string {
		return text.replace(/[\r\n]+/g, " ");
	}

	function isAssistantUsageEntry(entry: SessionEntryLike): entry is { type: "message"; message: AssistantMessageLike } {
		return entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage !== undefined;
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

		const availableForRight = Math.max(0, width - lw);
		const truncatedRight = availableForRight > 0 ? truncateToWidth(right, availableForRight) : "";
		const pad = Math.max(0, width - lw - visibleWidth(truncatedRight));
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

	function middleLabel(ctx: FooterContextLike, theme: FooterThemeLike): string {
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of ctx.sessionManager.getEntries()) {
			if (!isAssistantUsageEntry(entry)) continue;
			totalInput += entry.message.usage.input;
			totalOutput += entry.message.usage.output;
			totalCacheRead += entry.message.usage.cacheRead;
			totalCacheWrite += entry.message.usage.cacheWrite;
			totalCost += entry.message.usage.cost.total;
		}

		const parts: string[] = [];
		if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

		const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
		if (totalCost || usingSubscription) {
			parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		const contextUsage = ctx.getContextUsage();
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

	function installFooter(ctx: FooterContextLike) {
		if (!ctx?.hasUI) return;
		ctx.ui.setFooter((tui: FooterTuiLike, theme: FooterThemeLike, footerData: FooterDataLike) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose,
				render(width: number) {
					const cwdLabel = formatCwd(ctx.cwd ?? "");
					const left = cwdLabel ? theme.fg("accent", cwdLabel) : "";
					const middle = middleLabel(ctx, theme);
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

	pi.on("session_shutdown", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.reason === "reload") return;
		ctx.ui.setFooter(undefined);
	});


}
