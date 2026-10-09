import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const ResponseLength = StringEnum(["short", "medium", "long"] as const, {
	description: "Amount of content to return. Defaults to medium.",
});
const ContextSize = StringEnum(["low", "medium", "high"] as const);
export const SearchMode = StringEnum(["cached", "indexed", "live"] as const, {
	description: "Search access mode. Defaults to live; cached/indexed never use the local HTTP fallback.",
});
const Domains = Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 100 });
const Target = Type.String({ minLength: 1, maxLength: 8_000, description: "Public HTTP(S) URL or a reference returned by a web tool." });
const SessionHandle = Type.String({ minLength: 1, maxLength: 100, description: "Search session handle. Required when a reference occurs in multiple sessions." });
const Location = Type.Object({
	country: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2}$", description: "ISO two-letter country code." })),
	region: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	city: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "IANA timezone, e.g. Europe/Madrid." })),
}, { additionalProperties: false });
const SearchOptions = {
	mode: Type.Optional(SearchMode),
	context_size: Type.Optional(ContextSize),
	domains: Type.Optional(Domains),
	exclude_domains: Type.Optional(Domains),
	user_location: Type.Optional(Location),
	codex_model: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Registered openai-codex model ID. Defaults to the current Codex model or an available model." })),
	include_context: Type.Optional(Type.Boolean({ description: "Include bounded recent user/assistant text. Requires the user's --web-search-context opt-in; defaults to that flag. Never sends system instructions, tool outputs, thinking, or images." })),
};
const PageOptions = {
	search_session: Type.Optional(SessionHandle),
	mode: Type.Optional(SearchMode),
	refresh: Type.Optional(Type.Boolean({ description: "Bypass the short-lived local page cache. Does not bypass search-mode restrictions." })),
	response_length: Type.Optional(ResponseLength),
};
export const WebSearchParams = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 2_000, description: "Primary internet search query." }),
	additional_queries: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 3 })),
	recency_days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_650 })),
	response_length: Type.Optional(ResponseLength),
	...SearchOptions,
}, { additionalProperties: false });
export const WebFetchParams = Type.Object({
	url_or_ref: Target,
	line: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based line number, matching the L0, L1, ... labels in results." })),
	...PageOptions,
}, { additionalProperties: false });
export const WebFindParams = Type.Object({
	url_or_ref: Target,
	pattern: Type.String({ minLength: 1, maxLength: 1_000, description: "Literal text to find (case-insensitive for local pages)." }),
	...PageOptions,
}, { additionalProperties: false });
const Query = Type.Object({
	q: Type.String({ minLength: 1, maxLength: 2_000 }),
	recency: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_650 })),
	domains: Type.Optional(Domains),
}, { additionalProperties: false });
const batch = <T extends ReturnType<typeof Type.Object>>(item: T, maxItems = 8) =>
	Type.Optional(Type.Array(item, { minItems: 1, maxItems }));
export const CommandsSchema = Type.Object({
	search_query: batch(Query, 4),
	image_query: batch(Query, 4),
	open: batch(Type.Object({ ref_id: Target, lineno: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false })),
	click: batch(Type.Object({ ref_id: Target, id: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })),
	find: batch(Type.Object({ ref_id: Target, pattern: Type.String({ minLength: 1, maxLength: 1_000 }) }, { additionalProperties: false })),
	screenshot: batch(Type.Object({ ref_id: Target, pageno: Type.Integer({ minimum: 0, description: "Zero-based PDF page. Experimental; backend support varies." }) }, { additionalProperties: false }), 4),
	finance: batch(Type.Object({ ticker: Type.String({ minLength: 1, maxLength: 40 }), type: StringEnum(["equity", "fund", "crypto", "index"] as const), market: Type.Optional(Type.String({ maxLength: 20 })) }, { additionalProperties: false }), 4),
	weather: batch(Type.Object({ location: Type.String({ minLength: 1, maxLength: 200 }), start: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), duration: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) }, { additionalProperties: false }), 4),
	sports: batch(Type.Object({
		tool: Type.Optional(Type.Literal("sports")), fn: StringEnum(["schedule", "standings"] as const),
		league: StringEnum(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"] as const),
		team: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })), opponent: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
		date_from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), date_to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
		num_games: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), locale: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
	}, { additionalProperties: false }), 4),
	time: batch(Type.Object({ utc_offset: Type.String({ pattern: "^[+-](?:0\\d|1[0-4]):[0-5]\\d$" }) }, { additionalProperties: false }), 4),
	response_length: Type.Optional(ResponseLength),
}, { additionalProperties: false });
export const WebRunParams = Type.Object({
	...CommandsSchema.properties,
	...SearchOptions,
	search_session: Type.Optional(SessionHandle),
	image_settings: Type.Optional(Type.Object({ max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), caption: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const WebOutputSchema = Type.Object({
	operation: StringEnum(["search", "fetch", "find", "run"] as const),
	backend: StringEnum(["codex-direct", "http-direct"] as const),
	untrusted: Type.Literal(true),
	text: Type.String(),
	search_session: Type.Optional(Type.String()),
	mode: SearchMode,
	refs: Type.Array(Type.String()),
	sources: Type.Array(Type.Object({
		type: Type.Optional(Type.String()), refId: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()), snippet: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
	raw_results: Type.Optional(Type.Array(Type.Unknown())),
	raw_results_truncated: Type.Optional(Type.Boolean()),
	raw_results_path: Type.Optional(Type.String()),
	media: Type.Array(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }, { additionalProperties: false })),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String()),
	cached: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type WebSearchInput = Static<typeof WebSearchParams>;
export type WebFetchInput = Static<typeof WebFetchParams>;
export type WebFindInput = Static<typeof WebFindParams>;
export type WebRunInput = Static<typeof WebRunParams>;
export type WebOutput = Static<typeof WebOutputSchema>;
export type SearchCommands = Static<typeof CommandsSchema>;
export type SearchModeValue = Static<typeof SearchMode>;
export type ResponseLengthValue = Static<typeof ResponseLength>;
export type SearchOptionsInput = Pick<WebRunInput, keyof typeof SearchOptions | "image_settings">;
export interface SearchSettings {
	search_context_size?: "low" | "medium" | "high";
	filters?: { allowed_domains?: string[]; blocked_domains?: string[] };
	user_location?: { type: "approximate"; country?: string; region?: string; city?: string; timezone?: string };
	image_settings?: { max_results?: number; caption?: boolean };
	allowed_callers?: ["direct"];
	external_web_access?: boolean | "cached" | "indexed" | "live";
}
export interface SearchContextMessage {
	type: "message";
	role: "user" | "assistant";
	content: Array<{ type: "input_text" | "output_text"; text: string }>;
}
export type SearchInput = string | SearchContextMessage[];
