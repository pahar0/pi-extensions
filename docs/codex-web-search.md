# Codex web tools

Requires Pi 1.1.0 or later and `/login openai-codex` for remote operations. The extension calls Codex's standalone `alpha/search` endpoint directly; this is an implementation endpoint, not a guaranteed stable public API. Standalone live HTTP fetching does not require Codex authentication.

## Tools

- **`web_search`**: up to four related queries, recency/domain filters, approximate location, and search-context size.
- **`web_fetch`**: open a search reference or public URL, optionally positioned at a zero-based line.
- **`web_find`**: find literal text in a reference or public URL. Local matches are case-insensitive.
- **`web_run`**: up to 16 commands in one Codex request. Supports `search_query`, `open`, `find`, `click`, `finance`, `weather`, `sports`, `time`, and experimental `image_query`/PDF `screenshot`. Command schemas follow the current Codex request types, with bounded batch sizes.

Four search queries automatically upgrade a `short` response to `medium`. Reference IDs are local to backend sessions, not globally unique. Always pass the returned `search_session` when following references. Ambiguous IDs and references belonging to another session are rejected rather than silently routed to the wrong conversation. References in one batch must belong to the same session.

## Defaults and configuration

Live search remains the default. Flags can be set when starting Pi:

```bash
pi --web-search-mode cached
pi --web-search-model <registered-openai-codex-model-id>
pi --web-search-context
```

`mode` can also be supplied to search tools:

- `live`: allow live web access. Unmapped URLs may use safe local HTTP fetching.
- `cached`: send `external_web_access: false` to Codex.
- `indexed`: send `external_web_access: "indexed"` to Codex.

Cached/indexed operations **never** use the local HTTP fallback or page cache. A reference inherits its original mode, model, filters, and location. To deliberately change modes, start a new search, or pass a full URL with an explicit `mode` and no session handle. An ambiguous URL/session association requires a handle unless you explicitly select a new mode.

`codex_model` selects a registered model for a new session. Otherwise, the extension uses `--web-search-model`, the current Codex model, or an available Codex model. Existing sessions remain pinned to their original model; unavailable models produce an actionable error instead of silently switching.

`user_location` accepts optional `country` (two-letter ISO code), `region`, `city`, and IANA `timezone` fields. `domains` and `exclude_domains` accept hostnames, not paths or ports. Location and filter refinements in `web_run` persist for later navigation.

### Optional conversation context

Context sharing is **off by default**, even when the main conversation uses another provider. Only the user's `--web-search-context` flag enables it; a model cannot opt in by setting a tool parameter alone.

When enabled, remote calls may include:

- The latest two actual user text messages, capped at 8 KB each.
- Up to 4 KB of assistant text between them (approximately 1,000 tokens, not an exact tokenizer count).

System/developer instructions, environment-only messages, tool outputs, thinking, images, older turns, failed assistant messages, and commentary after the current user message are excluded. Explicit search commands are still sent separately. `include_context: false` disables sharing for a new search or subsequent `web_run` call; the preference is inherited by follow-ups. A resumed session never overrides a disabled user flag.

## Structured outputs and Codemode

All four tools declare an output schema. Model-facing text still includes the untrusted-content warning and source links. Codemode receives an object instead of a string:

```js
const search = await tools.web_search({ query: "latest TypeScript release", response_length: "short" });
text(search.sources.map(source => ({ title: source.title, url: source.url })));

const opened = await tools.web_fetch({
  url_or_ref: search.refs[0],
  search_session: search.search_session,
  response_length: "short"
});
text(opened.text);
```

The object includes `operation`, `backend`, `untrusted: true`, `text`, `mode`, `search_session`, `refs`, `sources`, `media`, and truncation/cache information. Unknown backend result fields are preserved in `raw_results`. Raw metadata is limited to 100 objects and 32 KB; omitted results are saved in `raw_results_path` when possible. Preserve the untrusted-data boundary when processing structured fields too.

Session handles/settings are stored in branch-local custom entries so nested Codemode calls also survive reload/resume. Old tool-result details remain readable. Tree navigation rebuilds only the active branch and clears the local cache. Calls sharing a backend session are queued; cancellation and branch changes cannot resurrect stale state.

### Batching and following links

```js
const search = await tools.web_search({ query: "OpenAI Codex documentation" });
const opened = await tools.web_fetch({ url_or_ref: search.refs[0], search_session: search.search_session });

const batch = await tools.web_run({
  search_session: search.search_session,
  open: [{ ref_id: search.refs[0], lineno: 0 }],
  find: [{ ref_id: search.refs[0], pattern: "configuration" }],
  response_length: "short"
});
text(batch.text);
```

Use `click: [{ ref_id: <opened-page-reference>, id: <numbered-link-id> }]` to follow a link numbered by Codex. Do not invent link IDs. Local HTML extraction preserves public link destinations but does not assign Codex click IDs; open those URLs instead.

Specialized commands use Codex's field names, e.g. `finance: [{ ticker: "BTC", type: "crypto", market: "" }]`, `weather: [{ location: "Madrid, Spain" }]`, or `time: [{ utc_offset: "+02:00" }]`. Backend availability can vary.

### Experimental media

`image_query` and zero-based PDF `screenshot` commands are exposed, but backend support is inconsistent. A successful request may return only text/metadata and no image attachments. Unsupported screenshot errors are surfaced with their reason and are not retried.

Validated inline PNG/JPEG/GIF/WebP payloads become Pi image blocks and appear in structured `media` (up to four images, 2 MB decoded total, and 20 million pixels total). Codemode can display them with:

```js
for (const block of batch.media) image(block);
```

Remote image URLs are preserved as metadata, **never downloaded automatically**. SVG, malformed base64, mismatched signatures, unreadable dimensions, and oversized inline payloads are not attached. PDF screenshot page numbers are zero-based.

## Local fetching, limits, and retries

Local fetching validates HTTP(S) URLs, rejects credentials and unsafe ports, rejects private/local/reserved DNS answers, pins the connection to a validated address, and revalidates every redirect. Private addresses and binary content remain blocked. Responses are capped at 5 MiB **after decompression**; stream errors and oversized bodies tear down the request/decompressor together.

Extracted HTML retains readable public links. Pages are cached in memory for two minutes, up to 16 pages and 8 MiB of text. `refresh: true` bypasses the local cache; it does not bypass mode or URL restrictions. The cache is cleared on branch/session changes.

Local fetch and find use matching zero-based labels (`L0`, `L1`, ...). `line: 1` starts at the line labeled `L1`, not the first line.

Text budgets apply to both Codex and local results:

| Response length | Content line budget | Content byte budget | Codex output-token budget |
| --- | ---: | ---: | ---: |
| short | 200 | 10,000 | 2,500 |
| medium (default) | 800 | 25,000 | 5,000 |
| long | 2,000 | 51,200 | 10,000 |

Truncation/file notices may add a small amount of text beyond these content budgets. When text is truncated, the complete formatted output is saved in `full_output_path` when possible. Structured sources/raw metadata and image data have separate bounded budgets; they are not part of the displayed-text budget.

Codex response bodies are capped at 6 MiB. Server errors, transport failures, and genuine internal errors retry at most twice with exponential backoff/jitter and stable session IDs. Retry-After is honored for retryable errors; waits over ten seconds are surfaced instead of sleeping indefinitely or retrying early. HTTP 429/401, malformed responses, URL safety refusals, and unsupported media operations are not blindly retried. Each attempt has a 45-second timeout, and the complete retry operation has a 90-second deadline. A backend safety refusal never falls back to local fetching.

## Development checks

```bash
npm run check
npm test
```

Tests use mocked Codex responses and page fetches for deterministic regressions, plus stream fixtures for decompression/error propagation. Live search/fetch/find/batching and all three mode values were smoke-tested separately; experimental media availability is not guaranteed.
