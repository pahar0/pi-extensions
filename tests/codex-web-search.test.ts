import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, {
	DirectSearchError, directPageResult, extractInlineMedia, extractReadableHtml, fetchPublicHttpPage,
	findTextMatches, isPublicIpAddress, normalizeHttpUrlKey, canonicalHttpAliases, prepareUrlArguments, readLimitedBody,
	type WebOutput, type WebSearchDependencies,
} from "../extensions/codex-web-search.ts";
import { PageCache, abortableDelay, recentSearchInput, retryAfterDelay, truncateUtf8 } from "../extensions/codex-web-search/support.ts";

type Entry = { type: "message"; id: string; message: Record<string, unknown> };
type Call = { url: string; body: Record<string, any>; headers: Headers; signal?: AbortSignal };
const TOKEN = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "mock-account" } })).toString("base64url")}.test`;
const model = { provider: "openai-codex", id: "mock-codex", baseUrl: "https://example.com/backend-api", headers: { "x-model": "yes", "x-remove": "remove" } };
const result = (ref = "turn0search0", url = "https://example.com/page") => ({ output: `Result ${ref}`, results: [{ type: "text_result", ref_id: ref, title: "Example", url, future_field: { preserved: true } }] });
const page = (text = "first\nsecond needle\nlast", url = "https://example.com/local") => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "text/plain", bodyBytes: Buffer.byteLength(text), title: "Page", text });
function harness(options: { persistCustom?: boolean; flags?: Record<string, unknown>; fetch?: (call: Call, index: number) => Promise<Response> | Response; fetchPage?: WebSearchDependencies["fetchPage"]; now?: () => number } = {}) {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionToolContext) => Promise<unknown>>();
	const flags = new Map<string, unknown>();
	const calls: Call[] = [];
	const delays: number[] = [];
	let entries: Entry[] = [];
	let availableModels = [model];
	const ctx = {
		model, modelRegistry: {
			getAll: () => availableModels, getAvailable: () => availableModels,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: TOKEN, headers: { "x-auth": "yes", "x-remove": null } }),
		}, sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionToolContext;
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (name: string, handler: (event: unknown, ctx: ExtensionToolContext) => Promise<unknown>) => handlers.set(name, handler),
		registerFlag: (name: string, settings: { default?: unknown }) => flags.set(name, options.flags?.[name] ?? settings.default),
		getFlag: (name: string) => flags.get(name),
		appendEntry: (customType: string, data: unknown) => {
			if (options.persistCustom) entries.push({ type: "custom", customType, data, id: `custom-${entries.length}` } as unknown as Entry);
		},
	} as unknown as ExtensionAPI;
	extension(pi, {
		fetch: async (url, init) => {
			const call = { url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), signal: init?.signal ?? undefined };
			calls.push(call);
			return options.fetch ? options.fetch(call, calls.length - 1) : Response.json(result());
		},
		fetchPage: options.fetchPage ?? (async (url) => page(undefined, url)),
		now: options.now, random: () => 0.5, sleep: async (ms, signal) => { signal?.throwIfAborted(); delays.push(ms); },
	});
	async function invoke(name: string, params: Record<string, unknown>, signal?: AbortSignal, persist = true) {
		const tool = tools.get(name)!;
		const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
		assert.ok(Value.Check(tool.parameters, prepared), `Invalid test arguments: ${JSON.stringify([...Value.Errors(tool.parameters, prepared)])}`);
		const toolResult = await tool.execute("test-call", prepared, signal, undefined, ctx);
		assert.ok(Value.Check(tool.outputSchema!, toolResult.structuredContent), JSON.stringify([...Value.Errors(tool.outputSchema!, toolResult.structuredContent)]));
		if (persist) entries.push({ type: "message", id: `entry-${entries.length}`, message: { role: "toolResult", toolName: name, details: toolResult.details } });
		return { result: toolResult, output: toolResult.structuredContent as unknown as WebOutput };
	}
	return { tools, calls, delays, flags, ctx, invoke,
		setBranch: (branch: Entry[]) => { entries = branch; }, getBranch: () => [...entries],
		setModels: (models: typeof availableModels) => { availableModels = models; },
		emit: (event: string) => handlers.get(event)!({}, ctx),
	};
}
const session = (value: { output: WebOutput }) => value.output.search_session!;
const text = (value: { result: AgentToolResult<unknown> }) => value.result.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join("\n");
const user = (id: string, content: unknown): Entry => ({ type: "message", id, message: { role: "user", content } });
const assistant = (id: string, content: unknown): Entry => ({ type: "message", id, message: { role: "assistant", content, stopReason: "stop" } });

test("tools expose structured schemas and honest read-only annotations", () => {
	const h = harness();
	assert.deepEqual([...h.tools.keys()], ["web_search", "web_fetch", "web_find", "web_run"]);
	for (const tool of h.tools.values()) {
		assert.ok(tool.outputSchema);
		assert.equal(tool.executionMode, "sequential");
		assert.equal(tool.annotations?.readOnlyHint, true);
		assert.equal(tool.annotations?.destructiveHint, false);
		assert.equal(tool.annotations?.openWorldHint, true);
	}
});

test("colliding references require an explicit session; wrong and unknown refs are rejected", async () => {
	const h = harness();
	const first = await h.invoke("web_search", { query: "first" });
	const second = await h.invoke("web_search", { query: "second" });
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "turn0search0" }), /ambiguous/);
	await h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(first) });
	assert.equal(h.calls.at(-1)!.body.id, h.calls[0]!.body.id);
	await h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(second) });
	assert.equal(h.calls.at(-1)!.body.id, h.calls[1]!.body.id);
	await assert.rejects(h.invoke("web_find", { url_or_ref: "turn99view0", pattern: "x", search_session: session(first) }), /does not belong/);
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "turn99view0" }), /Unknown or expired reference/);
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "https://example.com/new", search_session: "unknown" }), /Unknown or expired search_session/);
});

test("opaque structured reference IDs remain usable", async () => {
	const h = harness({ fetch: () => Response.json(result("future-ref:42")) });
	const search = await h.invoke("web_search", { query: "test" });
	assert.deepEqual(search.output.refs, ["future-ref:42"]);
	await h.invoke("web_fetch", { url_or_ref: "future-ref:42", search_session: session(search) });
	assert.equal(h.calls[1]!.body.commands.open[0].ref_id, "future-ref:42");
});

test("tree navigation restores only active-branch sessions and old persisted details", async () => {
	const h = harness();
	const first = await h.invoke("web_search", { query: "first" });
	const branch = h.getBranch();
	const second = await h.invoke("web_search", { query: "second" });
	h.setBranch(branch);
	await h.emit("session_tree");
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(second) }), /Unknown or expired/);
	await h.invoke("web_fetch", { url_or_ref: "turn0search0" });
	assert.equal(h.calls.at(-1)!.body.id, h.calls[0]!.body.id);
	const details = branch[0]!.message.details as any;
	delete details.searchSession.mode; delete details.searchSession.settings; delete details.searchSession.includeContext;
	h.setBranch(branch); await h.emit("session_start");
	const restored = await h.invoke("web_find", { url_or_ref: "turn0search0", pattern: "x", search_session: session(first) });
	assert.equal(restored.output.mode, "live");
});

test("HTTP 503, transport failures and logical errors retry with stable session identity", async () => {
	for (const failure of ["503", "transport", "internal"]) {
		const h = harness({ fetch: (_call, index) => {
			if (index > 0) return Response.json(result());
			if (failure === "transport") throw new TypeError("connection reset");
			return failure === "503" ? new Response("unavailable", { status: 503 }) : Response.json({ output: "Internal Error", results: [] });
		} });
		await h.invoke("web_search", { query: "test" });
		assert.equal(h.calls.length, 2); assert.deepEqual(h.delays, [200]);
		assert.equal(h.calls[0]!.body.id, h.calls[1]!.body.id);
	}
});

test("retries stop at three attempts, and failed sessions are not persisted", async () => {
	const h = harness({ fetch: () => new Response("unavailable", { status: 503 }) });
	await assert.rejects(h.invoke("web_search", { query: "test" }), (error) => error instanceof DirectSearchError && error.status === 503);
	assert.equal(h.calls.length, 3); assert.deepEqual(h.delays, [200, 400]); assert.equal(h.getBranch().length, 0);
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "turn0search0" }), /Unknown or expired/);
});

test("Retry-After seconds/date are respected, not clamped to an earlier retry", async () => {
	for (const retryAfter of ["1", "Thu, 01 Jan 1970 00:00:02 GMT"]) {
		const h = harness({ now: () => 0, fetch: (_call, index) => index === 0 ? new Response("unavailable", { status: 503, headers: { "Retry-After": retryAfter } }) : Response.json(result()) });
		await h.invoke("web_search", { query: "test" });
		assert.deepEqual(h.delays, [retryAfter === "1" ? 1000 : 2000]);
	}
	const h = harness({ fetch: () => new Response("unavailable", { status: 503, headers: { "Retry-After": "100" } }) });
	await assert.rejects(h.invoke("web_search", { query: "test" }), /too long/); assert.equal(h.calls.length, 1);
	assert.equal(retryAfterDelay("garbage"), undefined);
});

test("429, 401, invalid JSON and missing output are not retried", async () => {
	for (const response of [() => new Response("rate limited", { status: 429 }), () => new Response("unauthorized", { status: 401 }), () => new Response("not JSON"), () => Response.json({ wrong: true })]) {
		const h = harness({ fetch: response });
		await assert.rejects(h.invoke("web_search", { query: "test" })); assert.equal(h.calls.length, 1);
	}
});

test("Codex response bodies are bounded before parsing", async () => {
	const h = harness({ fetch: () => new Response("x".repeat(6 * 1024 * 1024 + 1)) });
	await assert.rejects(h.invoke("web_search", { query: "test" }), /safety size limit/); assert.equal(h.calls.length, 1);
});

test("caller cancellation is not retried", async () => {
	const controller = new AbortController();
	const h = harness({ fetch: () => { controller.abort(new Error("cancelled")); throw new Error("cancelled"); } });
	await assert.rejects(h.invoke("web_search", { query: "test" }, controller.signal), /cancelled/); assert.equal(h.calls.length, 1);
	const cancelled = new AbortController(); cancelled.abort(new Error("already cancelled"));
	await assert.rejects(abortableDelay(10_000, cancelled.signal), /already cancelled/);
	const waiting = new AbortController(); const delay = abortableDelay(10_000, waiting.signal); waiting.abort(new Error("stop waiting"));
	await assert.rejects(delay, /stop waiting/);
});

test("remote safety refusal never retries or falls back to local HTTP", async () => {
	let localCalls = 0;
	const h = harness({ fetch: (_call, index) => Response.json(index === 0 ? result() : { output: "URL https://example.com/page is not safe to open (non-retryable error)", results: [] }), fetchPage: async () => { localCalls++; return page(); } });
	const search = await h.invoke("web_search", { query: "test" });
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "https://example.com/page", search_session: session(search) }), /not safe/);
	assert.equal(localCalls, 0); assert.equal(h.calls.length, 2);
});

test("cached/indexed modes and inherited settings never use the HTTP fallback", async () => {
	for (const mode of ["cached", "indexed"] as const) {
		let localCalls = 0;
		const h = harness({ fetchPage: async () => { localCalls++; return page(); } });
		const search = await h.invoke("web_search", { query: "test", mode, context_size: "high", domains: ["OPENAI.COM"], exclude_domains: ["example.org"], user_location: { country: "us", city: "Seattle", timezone: "America/Los_Angeles" } });
		await h.invoke("web_fetch", { url_or_ref: "https://example.com/page", search_session: session(search) });
		await h.invoke("web_fetch", { url_or_ref: "https://example.com/standalone", mode });
		assert.equal(localCalls, 0);
		assert.equal(h.calls[0]!.body.settings.external_web_access, mode === "cached" ? false : "indexed");
		assert.deepEqual(h.calls[1]!.body.settings, h.calls[0]!.body.settings);
		assert.equal(h.calls[1]!.body.settings.user_location.country, "US");
	}
});

test("restricted modes surface remote errors without local fallback", async () => {
	let localCalls = 0;
	const h = harness({ flags: { "web-search-mode": "cached" }, fetch: () => new Response("unavailable", { status: 503 }), fetchPage: async () => { localCalls++; return page(); } });
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "https://example.com/page" }), /503/);
	assert.equal(localCalls, 0);
});

test("models remain pinned and custom model/auth headers are honored", async () => {
	const h = harness();
	const search = await h.invoke("web_search", { query: "test", codex_model: "mock-codex" });
	assert.equal(h.calls[0]!.url, "https://example.com/backend-api/codex/alpha/search");
	assert.equal(h.calls[0]!.headers.get("x-model"), "yes"); assert.equal(h.calls[0]!.headers.get("x-auth"), "yes"); assert.equal(h.calls[0]!.headers.get("x-remove"), null);
	h.setModels([{ ...model, id: "other" }]);
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(search) }), /not registered/);
	assert.equal(h.calls.length, 1);
});

test("domain overlap, conflicting query filters, invalid location and whitespace fail before networking", async () => {
	const h = harness();
	for (const args of [{ query: " " }, { query: "test", domains: ["openai.com"], exclude_domains: ["openai.com"] }, { query: "test", user_location: { timezone: "invalid/timezone" } }]) await assert.rejects(h.invoke("web_search", args));
	await assert.rejects(h.invoke("web_run", { search_query: [{ q: "test", domains: ["example.com"] }], exclude_domains: ["example.com"] }), /excluded/);
	assert.equal(h.calls.length, 0);
});

test("unknown result fields are preserved, bounded and spilled when oversized", async () => {
	const h = harness();
	const search = await h.invoke("web_search", { query: "test" });
	assert.deepEqual((search.output.raw_results![0] as any).future_field, { preserved: true });
	assert.equal(search.output.untrusted, true);
	const oversized = harness({ fetch: () => Response.json({ ...result(), results: [{ future_field: "x".repeat(40_000) }, { tiny: true }] }) });
	const big = await oversized.invoke("web_search", { query: "test" });
	assert.equal(big.output.raw_results_truncated, true); assert.deepEqual(big.output.raw_results, [{ tiny: true }]);
	assert.equal(JSON.parse(await readFile(big.output.raw_results_path!, "utf8"))[0].future_field.length, 40_000);
});

test("local fetch/find share a bounded TTL cache; refresh and tree reset invalidate it", async () => {
	let localCalls = 0; let now = 0;
	const h = harness({ now: () => now, fetchPage: async (url) => { localCalls++; return page(undefined, url); } });
	await h.invoke("web_fetch", { url_or_ref: "https://example.com/local" });
	const found = await h.invoke("web_find", { url_or_ref: "https://example.com/local", pattern: "needle" });
	assert.equal(found.output.cached, true); assert.equal(localCalls, 1); assert.match(found.output.text, /> L1:/);
	await h.invoke("web_fetch", { url_or_ref: "https://example.com/local", refresh: true }); assert.equal(localCalls, 2);
	now = 120_000; await h.invoke("web_fetch", { url_or_ref: "https://example.com/local" }); assert.equal(localCalls, 3);
	await h.emit("session_tree"); await h.invoke("web_fetch", { url_or_ref: "https://example.com/local" }); assert.equal(localCalls, 4);
	assert.equal(h.calls.length, 0);
});

test("PageCache evicts least-recently-used values by bytes and never admits oversized pages", () => {
	const cache = new PageCache<{ text: string }>(() => 0, 4);
	cache.set("a", { text: "aa" }); cache.set("b", { text: "bb" }); cache.get("a"); cache.set("c", { text: "cc" });
	assert.equal(cache.get("b"), undefined); assert.ok(cache.get("a"));
	cache.set("too big", { text: "xxxxx" }); assert.equal(cache.get("too big"), undefined);
});

test("short/medium/long local response budgets spill complete output", async () => {
	const h = harness({ fetchPage: async (url) => page(Array.from({ length: 1500 }, (_, i) => `line-${i}`).join("\n"), url) });
	const short = await h.invoke("web_fetch", { url_or_ref: "https://example.com/local", response_length: "short" });
	const medium = await h.invoke("web_fetch", { url_or_ref: "https://example.com/local", response_length: "medium" });
	const long = await h.invoke("web_fetch", { url_or_ref: "https://example.com/local", response_length: "long" });
	assert.ok(short.output.text.length < medium.output.text.length); assert.ok(medium.output.text.length < long.output.text.length);
	assert.equal(short.output.truncated, true); assert.equal(long.output.truncated, false);
	assert.match(await readFile(short.output.full_output_path!, "utf8"), /L1499: line-1499/);
	assert.match(text(short), /Full output saved/);
});

test("local line labels and fetch positioning use the same zero-based convention", async () => {
	const h = harness();
	const fetched = await h.invoke("web_fetch", { url_or_ref: "https://example.com/local", line: 1 });
	assert.equal(fetched.output.text, "L1: second needle\nL2: last");
	assert.match(findTextMatches("first\nneedle", "needle"), /> L1: needle/);
	assert.equal(directPageResult(page(), undefined, 0).output.startsWith("L0: first"), true);
});

test("HTML extraction retains resolved public links but not executable destinations", () => {
	const extracted = extractReadableHtml('<html><head><title>Test</title></head><body><article><p>Documentation with <a href="/docs">a useful link</a> and <a href="javascript:alert(1)">bad link</a>.</p><script>DO NOT INCLUDE</script></article></body></html>', "https://example.com/page");
	assert.match(extracted.text, /https:\/\/example.com\/docs/); assert.doesNotMatch(extracted.text, /javascript:|DO NOT INCLUDE/);
});

test("private/local/reserved addresses, credentials and unsafe ports are blocked on both paths", async () => {
	let localCalls = 0;
	const h = harness({ fetchPage: async () => { localCalls++; return page(); } });
	for (const url of ["http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "https://localhost/", "https://router.local/", "https://foo.home.arpa/", "https://user:pass@example.com/", "https://example.com:80/"]) {
		await assert.rejects(h.invoke("web_fetch", { url_or_ref: url }));
		await assert.rejects(h.invoke("web_run", { open: [{ ref_id: url }] }));
		await assert.rejects(fetchPublicHttpPage(url));
	}
	assert.equal(localCalls, 0); assert.equal(h.calls.length, 0);
	assert.equal(isPublicIpAddress("8.8.8.8"), true); assert.equal(isPublicIpAddress("::ffff:192.168.1.1"), false);
});

test("URL identity preserves trailing slash and canonical aliases never map API data to an unrelated repository page", () => {
	assert.notEqual(normalizeHttpUrlKey("https://example.com/docs"), normalizeHttpUrlKey("https://example.com/docs/"));
	assert.equal(normalizeHttpUrlKey("https://EXAMPLE.com/a#fragment"), "https://example.com/a");
	assert.deepEqual(canonicalHttpAliases("https://api.github.com/repos/openai/codex/issues/123"), ["https://api.github.com/repos/openai/codex/issues/123"]);
	assert.ok(canonicalHttpAliases("https://raw.githubusercontent.com/openai/codex/main/README.md").includes("https://github.com/openai/codex/blob/main/README.md"));
	assert.deepEqual(prepareUrlArguments({ url: "https://example.com" }), { url_or_ref: "https://example.com" });
});

test("web_run batches navigation and specialized commands while retaining its session", async () => {
	const h = harness();
	const search = await h.invoke("web_search", { query: "test" });
	const run = await h.invoke("web_run", {
		search_session: session(search), open: [{ ref_id: "turn0search0", lineno: 1 }, { ref_id: "https://example.com/other" }],
		find: [{ ref_id: "turn0search0", pattern: "test" }], click: [{ ref_id: "turn0search0", id: 17 }],
		finance: [{ ticker: "BTC", type: "crypto", market: "" }], weather: [{ location: "Madrid, Spain" }],
		sports: [{ fn: "standings", league: "nba" }], time: [{ utc_offset: "+02:00" }],
	});
	assert.equal(h.calls.length, 2); assert.equal(h.calls[1]!.body.id, h.calls[0]!.body.id);
	assert.equal(h.calls[1]!.body.commands.click[0].id, 17); assert.equal(h.calls[1]!.body.commands.open.length, 2);
	assert.equal(run.output.operation, "run");
});

test("web_run rejects empty/oversized batches and refs from different sessions", async () => {
	const h = harness({ fetch: (_call, index) => Response.json(result(`turn${index}search0`)) });
	await assert.rejects(h.invoke("web_run", {}), /between 1 and 16/);
	await assert.rejects(h.invoke("web_run", { open: Array.from({ length: 8 }, () => ({ ref_id: "https://example.com" })), find: Array.from({ length: 8 }, () => ({ ref_id: "https://example.com", pattern: "x" })), time: [{ utc_offset: "+02:00" }] }), /between 1 and 16/);
	await h.invoke("web_search", { query: "first" }); await h.invoke("web_search", { query: "second" });
	await assert.rejects(h.invoke("web_run", { open: [{ ref_id: "turn0search0" }, { ref_id: "turn1search0" }] }), /does not belong|single search_session/);
});

test("four queries cannot use a short response", async () => {
	const h = harness();
	await h.invoke("web_search", { query: "one", additional_queries: ["two", "three", "four"], response_length: "short" });
	await h.invoke("web_run", { search_query: ["one", "two", "three", "four"].map((q) => ({ q })), response_length: "short" });
	assert.equal(h.calls[0]!.body.commands.response_length, "medium"); assert.equal(h.calls[1]!.body.commands.response_length, "medium");
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
test("experimental media commands pass through and validated inline images become image blocks", async () => {
	const h = harness({ fetch: () => Response.json({ output: "Screenshot", results: [{ type: "image_result", image_url: `data:image/png;base64,${PNG}` }] }) });
	const run = await h.invoke("web_run", { image_query: [{ q: "waterfalls" }], screenshot: [{ ref_id: "https://example.com/paper.pdf", pageno: 0 }], image_settings: { max_results: 2, caption: true } });
	assert.equal(h.calls[0]!.body.commands.screenshot[0].pageno, 0); assert.deepEqual(run.output.media, [{ type: "image", data: PNG, mimeType: "image/png" }]);
	assert.ok(run.result.content.some((item) => item.type === "image"));
	assert.deepEqual(extractInlineMedia([{ image_url: "https://example.com/image.png" }, { data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }, { image_url: "data:image/svg+xml;base64,PHN2Zz4=" }]), []);
});

test("truncated and excessive-dimension inline images are not attached", () => {
	assert.deepEqual(extractInlineMedia([{ data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"), mimeType: "image/png" }]), []);
	const huge = Buffer.from(PNG, "base64"); huge.writeUInt32BE(100_000, 16); huge.writeUInt32BE(100_000, 20);
	assert.deepEqual(extractInlineMedia([{ data: huge.toString("base64"), mimeType: "image/png" }]), []);
});

test("inherited filter conflicts fail before a new request is sent", async () => {
	const h = harness();
	const search = await h.invoke("web_search", { query: "test", exclude_domains: ["blocked.com"] });
	await assert.rejects(h.invoke("web_run", { search_session: session(search), time: [{ utc_offset: "+02:00" }], domains: ["blocked.com"] }), /inherited session filters/);
	assert.equal(h.calls.length, 1);
});

test("compressed HTTP bodies are decoded, capped after decompression, and torn down on errors", async () => {
	const content = Buffer.from("decoded text".repeat(100));
	for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
		const response = Object.assign(Readable.from([compress(content)]), { headers: { "content-encoding": encoding } }) as unknown as IncomingMessage;
		assert.deepEqual(await readLimitedBody(response, 10_000), content);
	}
	const oversized = Object.assign(Readable.from([gzipSync(Buffer.alloc(100_000, "x"))]), { headers: { "content-encoding": "gzip" } }) as unknown as IncomingMessage;
	await assert.rejects(readLimitedBody(oversized, 1000), /safety limit/); assert.equal(oversized.destroyed, true);
	const broken = Object.assign(new Readable({ read() { this.destroy(new Error("socket closed")); } }), { headers: { "content-encoding": "gzip" } }) as unknown as IncomingMessage;
	await assert.rejects(readLimitedBody(broken, 10_000), /socket closed/);
	const unsupported = Object.assign(Readable.from([content]), { headers: { "content-encoding": "unknown" } }) as unknown as IncomingMessage;
	await assert.rejects(readLimitedBody(unsupported, 10_000), /Unsupported Content-Encoding/); assert.equal(unsupported.destroyed, true);
});

test("response-stream failures use transport retries", async () => {
	const h = harness({ fetch: (_call, index) => index === 0 ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken response stream")); } })) : Response.json(result()) });
	await h.invoke("web_search", { query: "test" }); assert.equal(h.calls.length, 2);
});

test("unsupported screenshot failures are actionable and not retried", async () => {
	const h = harness({ fetch: () => Response.json({ output: "Internal Error", results: [{ title: "Internal Error", snippet: "Unable to resolve screenshot call because web screenshot is not supported" }] }) });
	await assert.rejects(h.invoke("web_run", { screenshot: [{ ref_id: "https://example.com/paper.pdf", pageno: 0 }] }), /cannot perform this media operation/);
	assert.equal(h.calls.length, 1);
});

test("mixed success/error batches preserve usable results instead of discarding the whole batch", async () => {
	const h = harness({ fetch: () => Response.json({ output: "Internal Error\nA second command succeeded", results: [{ title: "Internal Error" }, result().results[0]] }) });
	const run = await h.invoke("web_run", { time: [{ utc_offset: "+02:00" }] });
	assert.equal(run.output.sources.length, 2); assert.equal(h.calls.length, 1);
});

test("context sharing is user-controlled, off by default, and bounded", async () => {
	const h = harness();
	h.setBranch([user("previous", "previous user"), assistant("answer", [{ type: "text", text: "answer" }, { type: "thinking", thinking: "secret thinking" }]), user("current", [{ type: "text", text: "current user" }, { type: "image", data: "secret image" }])]);
	await h.invoke("web_search", { query: "test" }); assert.equal(h.calls[0]!.body.input, "test");
	await assert.rejects(h.invoke("web_search", { query: "test", include_context: true }), /opt in/);
	h.flags.set("web-search-context", true);
	await h.invoke("web_search", { query: "test" });
	assert.deepEqual(h.calls[1]!.body.input.map((message: any) => message.content[0].text), ["previous user", "answer", "current user"]);
	await h.invoke("web_search", { query: "test", include_context: false }); assert.equal(h.calls[2]!.body.input, "test");
	const big = harness({ flags: { "web-search-context": true } });
	big.setBranch([user("old", "older user"), user("previous", "u".repeat(20_000)), assistant("answer", [{ type: "text", text: "a".repeat(20_000) }]), user("environment", "<environment_context>secret</environment_context>"), user("current", "current user"), assistant("commentary", [{ type: "text", text: "current commentary" }])]);
	await big.invoke("web_search", { query: "test" });
	const input = big.calls[0]!.body.input;
	assert.equal(input.length, 3); assert.equal(Buffer.byteLength(input[0].content[0].text), 8000); assert.equal(Buffer.byteLength(input[1].content[0].text), 4000);
	assert.doesNotMatch(JSON.stringify(input), /older user|secret|commentary/);
	assert.equal(truncateUtf8("🐱🐱", 5), "🐱"); assert.equal(truncateUtf8("🐱🐱", 5, true), "🐱");
	const empty = harness(); assert.equal(recentSearchInput(empty.ctx, "fallback"), "fallback");
});

test("restored context opt-in never overrides a user's disabled flag", async () => {
	const h = harness({ flags: { "web-search-context": true } }); h.setBranch([user("user", "private context")]);
	const search = await h.invoke("web_search", { query: "test" });
	h.flags.set("web-search-context", false); await h.emit("session_start");
	await h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(search) });
	assert.equal(typeof h.calls[1]!.body.input, "string");
});

test("operations sharing one server session are serialized", async () => {
	let active = 0; let maximum = 0;
	const h = harness({ fetch: async (call) => {
		if (call.body.commands.open) {
			active++; maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 5)); active--;
		}
		return Response.json(result());
	} });
	const search = await h.invoke("web_search", { query: "test" });
	await Promise.all([h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(search) }), h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(search) })]);
	assert.equal(maximum, 1);
});

test("nested Codemode search handles survive resume through branch-local custom data", async () => {
	const h = harness({ persistCustom: true });
	const search = await h.invoke("web_search", { query: "test", mode: "cached" }, undefined, false);
	assert.equal(h.getBranch().length, 1);
	await h.emit("session_start");
	await h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(search) });
	assert.equal(h.calls[0]!.body.id, h.calls[1]!.body.id);
	assert.equal(h.calls[1]!.body.settings.external_web_access, false);
});

test("cancelled queued calls do not allow a third call to overtake an active request", async () => {
	let release!: () => void; let started!: () => void; let opens = 0;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({ fetch: async (call) => {
		if (call.body.commands.open && ++opens === 1) { started(); await hold; }
		return Response.json(result());
	} });
	const search = await h.invoke("web_search", { query: "test" });
	const args = { url_or_ref: "turn0search0", search_session: session(search) };
	const first = h.invoke("web_fetch", args); await ready;
	const controller = new AbortController();
	const second = h.invoke("web_fetch", args, controller.signal);
	controller.abort(new Error("cancel queued call")); await assert.rejects(second, /cancel queued/);
	const third = h.invoke("web_fetch", args);
	await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(opens, 1);
	release(); await Promise.all([first, third]); assert.equal(opens, 2);
});

test("an explicit mode on a full URL starts fresh without silently changing an existing session", async () => {
	const h = harness();
	await h.invoke("web_search", { query: "test", mode: "cached" });
	const fetched = await h.invoke("web_fetch", { url_or_ref: "https://example.com/page", mode: "live" });
	assert.equal(fetched.output.backend, "http-direct"); assert.equal(fetched.output.search_session, undefined);
});

test("per-call settings refinements preserve inherited filters and location", async () => {
	const h = harness();
	const search = await h.invoke("web_search", { query: "test", domains: ["example.com"], exclude_domains: ["blocked.com"], user_location: { country: "US", city: "Seattle" } });
	await h.invoke("web_run", { search_session: session(search), time: [{ utc_offset: "+02:00" }], domains: ["openai.com"], user_location: { city: "Portland" } });
	assert.deepEqual(h.calls[1]!.body.settings.filters, { allowed_domains: ["openai.com"], blocked_domains: ["blocked.com"] });
	assert.equal(h.calls[1]!.body.settings.user_location.country, "US");
	assert.equal(h.calls[1]!.body.settings.user_location.city, "Portland");
});

test("queued settings updates inherit the latest successful session revision", async () => {
	let release!: () => void; let started!: () => void; let timeCalls = 0;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({ fetch: async (call) => {
		if (call.body.commands.time && ++timeCalls === 1) { started(); await hold; }
		return Response.json(result());
	} });
	const search = await h.invoke("web_search", { query: "test", domains: ["example.com"], user_location: { country: "US" } });
	const first = h.invoke("web_run", { search_session: session(search), time: [{ utc_offset: "+02:00" }], domains: ["openai.com"] });
	await ready;
	const second = h.invoke("web_run", { search_session: session(search), time: [{ utc_offset: "+03:00" }], user_location: { city: "Seattle" } });
	release(); await Promise.all([first, second]);
	assert.deepEqual(h.calls[2]!.body.settings.filters.allowed_domains, ["openai.com"]);
	assert.equal(h.calls[2]!.body.settings.user_location.country, "US");
});

test("out-of-order tool-result persistence never rolls back newer session settings", async () => {
	const h = harness();
	const search = await h.invoke("web_search", { query: "test" });
	await h.invoke("web_run", { search_session: session(search), time: [{ utc_offset: "+02:00" }], context_size: "high" });
	await h.invoke("web_run", { search_session: session(search), time: [{ utc_offset: "+03:00" }], context_size: "low" });
	const branch = h.getBranch(); h.setBranch([branch[0]!, branch[2]!, branch[1]!]);
	await h.emit("session_start");
	await h.invoke("web_fetch", { url_or_ref: "turn0search0", search_session: session(search) });
	assert.equal(h.calls[3]!.body.settings.search_context_size, "low");
});

test("find context retains matches beyond the long-line display limit", () => {
	assert.match(findTextMatches("x".repeat(5000) + "needle", "needle"), /needle/);
});

test("an in-flight request cannot resurrect sessions after branch navigation", async () => {
	let release!: () => void; let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const h = harness({ fetch: async () => { started(); await hold; return Response.json(result()); } });
	const running = h.invoke("web_search", { query: "test" }); await ready;
	h.setBranch([]); await h.emit("session_tree"); release();
	await assert.rejects(running, /session changed/);
	await assert.rejects(h.invoke("web_fetch", { url_or_ref: "turn0search0" }), /Unknown or expired/);
});
