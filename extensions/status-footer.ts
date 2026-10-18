// Last verified working with Pi v1.2.0
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

type ModelLike = Model<Api>;

type UsageLike = {
	input: number;
	output: number;
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

type SubscriptionWindow = {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
};

type CodexUsage = {
	primary?: SubscriptionWindow;
	secondary?: SubscriptionWindow;
	monthly?: SubscriptionWindow;
};

export default function statusFooter(pi: ExtensionAPI) {
	let codexUsage: CodexUsage | undefined;
	let quotaUnavailable = false;
	let requestFooterRender: (() => void) | undefined;
	let quotaActive = false;
	let quotaRequest: AbortController | undefined;
	let quotaAuthKey: string | undefined;
	let lastQuotaAttempt = -Infinity;
	let lastQuotaUpdate = 0;

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

	function isUsingSubscription(ctx: FooterContextLike): boolean {
		return ctx.model !== undefined && (
			ctx.model.provider === "kimi-coding" ||
			(ctx.modelRegistry.isUsingOAuth(ctx.model) &&
				ctx.modelRegistry.getProvider(ctx.model.provider)?.auth.oauth?.isSubscription === true)
		);
	}

	function isCodexSubscription(ctx: FooterContextLike): boolean {
		return ctx.model?.provider === "openai-codex" && isUsingSubscription(ctx);
	}

	function finiteNumber(value: unknown): number | undefined {
		if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
		const number = Number(value);
		return Number.isFinite(number) ? number : undefined;
	}

	function subscriptionWindow(used: unknown, minutes: unknown, reset: unknown): SubscriptionWindow | undefined {
		const usedPercent = finiteNumber(used);
		if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return undefined;
		const windowMinutes = finiteNumber(minutes);
		const resetsAt = finiteNumber(reset);
		return {
			usedPercent,
			windowMinutes: windowMinutes !== undefined && windowMinutes > 0 ? windowMinutes : undefined,
			resetsAt: resetsAt !== undefined && resetsAt > 0 ? resetsAt : undefined,
		};
	}

	function streamSubscriptionWindow(value: unknown): SubscriptionWindow | undefined {
		if (!value || typeof value !== "object") return undefined;
		const window = value as Record<string, unknown>;
		return subscriptionWindow(window.used_percent, window.window_minutes, window.reset_at);
	}

	function updateCodexUsage(usage: CodexUsage, authoritative = false) {
		if (!authoritative && !Object.values(usage).some(Boolean)) return;
		codexUsage = {
			...usage,
			// Response headers/events omit monthly spend controls; only the usage endpoint can clear them.
			monthly: authoritative ? usage.monthly : usage.monthly ?? codexUsage?.monthly,
		};
		quotaUnavailable = authoritative && !Object.values(codexUsage).some(Boolean);
		lastQuotaUpdate = Date.now();
		requestFooterRender?.();
	}

	function resetCodexUsage() {
		quotaRequest?.abort();
		quotaRequest = undefined;
		quotaAuthKey = undefined;
		lastQuotaAttempt = -Infinity;
		lastQuotaUpdate = 0;
		codexUsage = undefined;
		quotaUnavailable = false;
		requestFooterRender?.();
	}

	function hasCurrentCodexUsage(): boolean {
		return Object.values(codexUsage ?? {}).some((window) => window && (
			window.resetsAt === undefined || window.resetsAt * 1000 > Date.now()
		));
	}

	function usageEndpointWindow(value: unknown): SubscriptionWindow | undefined {
		if (!value || typeof value !== "object") return undefined;
		const window = value as Record<string, unknown>;
		const seconds = finiteNumber(window.limit_window_seconds);
		return subscriptionWindow(
			window.used_percent,
			seconds !== undefined && seconds > 0 ? Math.ceil(seconds / 60) : undefined,
			window.reset_at,
		);
	}

	function record(value: unknown): Record<string, unknown> | undefined {
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown> : undefined;
	}

	function monthlySubscriptionUsage(value: unknown): SubscriptionWindow | undefined {
		const limit = record(value);
		if (!limit) return undefined;
		const maximum = finiteNumber(limit.limit);
		if (maximum !== undefined && maximum <= 0) return undefined;
		const remaining = finiteNumber(limit.remaining_percent);
		const used = finiteNumber(limit.used);
		const percent = finiteNumber(limit.used_percent) ?? (
			remaining !== undefined && remaining >= 0 && remaining <= 100 ? 100 - remaining
				: maximum !== undefined && used !== undefined && used >= 0 ? (used / maximum) * 100
				: undefined
		);
		return subscriptionWindow(percent, undefined, limit.reset_at ?? limit.resets_at);
	}

	// Some accounts omit quota headers/events. Resolve current auth through Pi, never auth.json.
	async function refreshCodexUsage(ctx: ExtensionContext): Promise<void> {
		if (!quotaActive || ctx.mode !== "tui" || !isCodexSubscription(ctx) || !ctx.model || quotaRequest) return;

		const model = ctx.model;
		const controller = new AbortController();
		quotaRequest = controller;
		const isCurrent = () => !controller.signal.aborted && quotaActive &&
			quotaRequest === controller && ctx.model === model && isCodexSubscription(ctx);
		try {
			const usageBeforeAuth = codexUsage;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!isCurrent()) return;
			if (!auth.ok || !auth.apiKey) return;
			// Do not send credentials for a custom/proxied provider to OpenAI's usage endpoint.
			const baseUrl = new URL(auth.baseUrl ?? model.baseUrl);
			if (baseUrl.origin !== "https://chatgpt.com") return;

			const claims = JSON.parse(Buffer.from(auth.apiKey.split(".")[1] ?? "", "base64url").toString("utf8"));
			const accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
			if (typeof accountId !== "string" || !accountId) return;
			// Keep only a fingerprint in memory so /login detects a changed account without retaining tokens.
			const authKey = createHash("sha256").update(auth.apiKey).digest("hex");
			if (quotaAuthKey !== authKey) {
				quotaAuthKey = authKey;
				lastQuotaAttempt = -Infinity;
				if (codexUsage === usageBeforeAuth) {
					codexUsage = undefined;
					quotaUnavailable = false;
				}
				requestFooterRender?.();
			}
			if (
				(hasCurrentCodexUsage() && !codexUsage?.monthly && Date.now() - lastQuotaUpdate < 60_000) ||
				Date.now() - lastQuotaAttempt < 60_000
			) return;
			lastQuotaAttempt = Date.now();
			const previousUsage = codexUsage;
			const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
				headers: {
					Authorization: `Bearer ${auth.apiKey}`,
					"ChatGPT-Account-Id": accountId,
					Accept: "application/json",
					"User-Agent": "pi-status-footer",
				},
				redirect: "error",
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
			});
			if (!response.ok) {
				await response.body?.cancel();
				return;
			}
			const data: unknown = await response.json();
			if (!isCurrent()) return;
			const currentAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!isCurrent()) return;
			if (!currentAuth.ok || !currentAuth.apiKey ||
				createHash("sha256").update(currentAuth.apiKey).digest("hex") !== authKey) {
				resetCodexUsage();
				return;
			}
			const payload = record(data);
			if (!payload) return;
			const windows = record(payload.rate_limit);
			const primary = usageEndpointWindow(windows?.primary_window);
			const secondary = usageEndpointWindow(windows?.secondary_window);
			const monthly = monthlySubscriptionUsage(record(payload.spend_control)?.individual_limit);
			// A newer stream snapshot wins for rolling windows, but it contains no monthly allowance.
			if (codexUsage === previousUsage) {
				updateCodexUsage({ primary, secondary, monthly }, true);
			} else {
				updateCodexUsage({ ...codexUsage, monthly }, true);
			}
		} catch {
			// Quota reporting is best-effort; failures must not interrupt the session.
		} finally {
			if (quotaRequest === controller) quotaRequest = undefined;
		}
	}

	function codexSubscriptionLabel(theme: FooterThemeLike): string {
		const windows: string[] = [];
		for (const [name, window] of Object.entries(codexUsage ?? {})) {
			if (!window || (window.resetsAt !== undefined && window.resetsAt * 1000 <= Date.now())) continue;
			const minutes = window.windowMinutes;
			const label = minutes === undefined ? name
				: minutes % 1440 === 0 ? `${minutes / 1440}d`
				: minutes % 60 === 0 ? `${minutes / 60}h`
				: `${minutes}m`;
			const color = window.usedPercent >= 90 ? "error" : window.usedPercent >= 75 ? "warning" : "dim";
			windows.push(`${theme.fg("dim", `${label}:`)}${theme.fg(color, `${window.usedPercent.toFixed(1)}%`)}`);
		}
		return windows.length > 0
			? `${theme.fg("dim", "(sub ")}${windows.join(" ")}${theme.fg("dim", ")")}`
			: theme.fg("dim", quotaUnavailable ? "(sub n/a)" : "(sub ?)");
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
		totalCacheWrite: number;
		totalCost: number;
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
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of ctx.sessionManager.getEntries()) {
			const usage = getEntryUsage(entry);
			if (!usage) continue;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
		}

		return {
			totalInput,
			totalOutput,
			totalCacheWrite,
			totalCost,
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
			totalCacheWrite,
			totalCost,
			contextUsage,
		} = stats;
		const parts: string[] = [];
		if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

		if (isUsingSubscription(ctx)) {
			parts.push(isCodexSubscription(ctx) ? codexSubscriptionLabel(theme) : theme.fg("dim", "(sub)"));
		} else if (totalCost && ctx.model && !ctx.modelRegistry.isUsingOAuth(ctx.model)) {
			parts.push(`$${totalCost.toFixed(3)}`);
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
			const requestRender = () => tui.requestRender();
			requestFooterRender = requestRender;
			const unsubscribe = footerData.onBranchChange(requestRender);
			const getSessionStats = createSessionStatsGetter(ctx);
			return {
				dispose() {
					unsubscribe();
					if (requestFooterRender === requestRender) requestFooterRender = undefined;
				},
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

	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.mode !== "tui" || !isCodexSubscription(ctx)) return;
		const headers = Object.fromEntries(Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value]));
		const window = (name: string) => subscriptionWindow(
			headers[`x-codex-${name}-used-percent`],
			headers[`x-codex-${name}-window-minutes`],
			headers[`x-codex-${name}-reset-at`],
		);
		updateCodexUsage({ primary: window("primary"), secondary: window("secondary") });
	});

	// WebSocket responses do not expose HTTP headers; Codex sends quota updates in the stream instead.
	pi.on("provider_stream_event", (event, ctx) => {
		if (ctx.mode !== "tui" || event.provider !== "openai-codex" || !isCodexSubscription(ctx)) return;
		if (!event.data || typeof event.data !== "object") return;
		const data = event.data as Record<string, unknown>;
		if (data.type !== "codex.rate_limits") return;
		const limit = data.metered_limit_name ?? data.limit_name;
		if (limit !== undefined && limit !== null && limit !== "codex") return;
		if (!data.rate_limits || typeof data.rate_limits !== "object") return;
		const limits = data.rate_limits as Record<string, unknown>;
		updateCodexUsage({
			primary: streamSubscriptionWindow(limits.primary),
			secondary: streamSubscriptionWindow(limits.secondary),
		});
	});

	pi.on("session_start", (_event, ctx) => {
		resetCodexUsage();
		quotaActive = true;
		installFooter(ctx);
		void refreshCodexUsage(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		resetCodexUsage();
		void refreshCodexUsage(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		// /login does not necessarily emit model_select. Check current credentials on the next prompt.
		void refreshCodexUsage(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		void refreshCodexUsage(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", (event, ctx) => {
		quotaActive = false;
		resetCodexUsage();
		if (ctx.mode !== "tui") return;
		if (event.reason === "reload") return;
		ctx.ui.setFooter(undefined);
	});


}
