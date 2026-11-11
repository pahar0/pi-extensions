// Adapted for Pi from OpenAI Codex (Apache-2.0), commit aef7d276.
// Copyright 2025 OpenAI. Pi-specific transport, auth, storage and result handling added.
// See LICENSE.codex, NOTICE.codex and UPSTREAM.md.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareImages, type ImageParams, type InputImageIdentity } from "./inputs.ts";
export type { ImageParams } from "./inputs.ts";

export const IMAGE_MODEL = "gpt-image-2";
export const IMAGE_BASE_URL = "https://chatgpt.com/backend-api/codex";
const TIMEOUT_MS = 300_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;

export interface ImageMetadata {
	path?: string;
	input_images: InputImageIdentity[];
	transparent_background?: boolean;
	generation_id?: string;
	model: string;
	auth: "subscription";
	operation: "generate" | "edit";
	mimeType: "image/png";
	bytes: number;
	width: number;
	height: number;
	quality?: string;
	size?: string;
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

export interface ImageResult {
	metadata: ImageMetadata;
	output_hint?: string;
	data: string;
	usage?: Usage;
}

export interface ImageDependencies {
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** Host-side equivalent of CODEX_HOME; never a model-facing argument. */
	saveRoot?: string;
}

type ImageContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "sessionManager">;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

export function pngDimensions(bytes: Buffer): { width: number; height: number } {
	if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
		bytes.toString("ascii", 12, 16) !== "IHDR") {
		throw new Error("Codex returned invalid PNG image data.");
	}
	const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
	if (!width || !height) throw new Error("Codex returned invalid PNG dimensions.");
	return { width, height };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		// The host may have started auth resolution just before cancellation.
		void work.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
	});
}

async function resolveAuth(ctx: ImageContext, signal: AbortSignal): Promise<{ token: string; accountId: string }> {
	const supported = (provider: string) => provider === "openai-codex" || provider === "openai";
	const model = ctx.model && supported(ctx.model.provider) && ctx.modelRegistry.isUsingOAuth(ctx.model)
		? ctx.model
		: ctx.modelRegistry.getAvailable().find((candidate) => supported(candidate.provider) && ctx.modelRegistry.isUsingOAuth(candidate));
	if (!model) throw new Error("A ChatGPT/Codex subscription login is required. Run /login openai-codex. API-key fallback is disabled.");
	let auth;
	try {
		// Pi owns OAuth refresh, locking and persistence. Never read auth.json or shell secrets.
		auth = await abortable(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
	} catch {
		signal.throwIfAborted();
		throw new Error("Unable to resolve Codex subscription authentication. Sign in again with /login.");
	}
	if (!auth.ok || !auth.apiKey || !ctx.modelRegistry.isUsingOAuth(model)) {
		throw new Error("Codex subscription authentication is unavailable. Sign in again with /login. API-key fallback is disabled.");
	}
	let base: URL;
	try { base = new URL(auth.baseUrl ?? model.baseUrl); }
	catch { throw new Error("Invalid Codex provider endpoint."); }
	if (base.origin !== "https://chatgpt.com" || base.username || base.password || base.search || base.hash ||
		!["/backend-api", "/backend-api/", "/backend-api/codex", "/backend-api/codex/"].includes(base.pathname)) {
		throw new Error("Subscription image generation supports only the first-party ChatGPT Codex endpoint, not custom providers or proxies.");
	}
	let accountId: unknown;
	try {
		const claims = record(JSON.parse(Buffer.from(auth.apiKey.split(".")[1] ?? "", "base64url").toString("utf8")));
		accountId = record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
	} catch { /* The error below never includes a credential. */ }
	if (typeof accountId !== "string" || !accountId || /[\r\n]/.test(accountId)) {
		throw new Error("Codex OAuth token has no valid ChatGPT account ID. Sign in again with /login.");
	}
	signal.throwIfAborted();
	return { token: auth.apiKey, accountId };
}

async function readBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Codex returned an empty response.");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			length += value.byteLength;
			if (length > limit) throw new Error("Codex image response exceeded the size limit.");
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		// Cancel on size limits and aborts as well as on ordinary completion.
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function safeError(payload: unknown, secrets: string[]): string {
	const object = record(payload);
	const error = record(object?.error);
	const rawMessage = error?.message ?? object?.message;
	if (typeof rawMessage !== "string") return "";
	let message = rawMessage;
	for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[REDACTED]");
	return message.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").slice(0, 500).trim();
}

function tokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usageFromResponse(value: unknown): Usage | undefined {
	const usage = record(value);
	const input = tokenCount(usage?.input_tokens), output = tokenCount(usage?.output_tokens);
	if (input === undefined || output === undefined) return undefined;
	return {
		input, output, cacheRead: 0, cacheWrite: 0,
		totalTokens: tokenCount(usage?.total_tokens) ?? input + output,
		// Subscription usage has no per-call API dollar price.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function imageArtifactPath(saveRoot: string, sessionId: string, callId: string): string {
	const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_") || "generated_image";
	return join(saveRoot, "generated_images", sanitize(sessionId), `${sanitize(callId)}.png`);
}

export function imageOutputHint(path: string): string | undefined {
	const hint = `Generated images are saved to ${dirname(path)} as ${path} by default.\nIf you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.\nThe generated image is already displayed to the user. There is no need to render it in the final response as a Markdown image or file link.`;
	return Buffer.byteLength(hint) <= 1024 ? hint : undefined;
}

async function saveImage(path: string, bytes: Buffer): Promise<string | undefined> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		return path;
	} catch {
		// Like Codex, persistence is best-effort: still return the completed image.
		// Pi deliberately never clobbers a pre-existing artifact.
		return undefined;
	}
}

export async function generateImage(
	toolCallId: string,
	params: ImageParams,
	ctx: ImageContext,
	signal?: AbortSignal,
	dependencies: ImageDependencies = {},
): Promise<ImageResult> {
	const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(dependencies.timeoutMs ?? TIMEOUT_MS)]);
	requestSignal.throwIfAborted();
	const { images, input_images } = await prepareImages(params, ctx, requestSignal);
	const auth = await resolveAuth(ctx, requestSignal);
	const operation = images.length ? "edit" : "generate";
	let response: Response;
	try {
		// No automatic retries: an interrupted POST may already have consumed subscription quota.
		response = await (dependencies.fetch ?? fetch)(`${IMAGE_BASE_URL}/images/${images.length ? "edits" : "generations"}`, {
			method: "POST",
			redirect: "error",
			signal: requestSignal,
			headers: {
				Authorization: `Bearer ${auth.token}`,
				"ChatGPT-Account-ID": auth.accountId,
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": "pi-codex-imagegen",
				originator: "pi",
				"x-codex-image-turn-id": randomUUID(),
			},
			body: JSON.stringify({
				model: IMAGE_MODEL, prompt: params.prompt,
				background: params.transparent_background ? "transparent" : "opaque",
				quality: "auto", size: "auto",
				...(images.length ? { images } : {}),
			}),
		});
	} catch {
		requestSignal.throwIfAborted();
		throw new Error("Codex image request failed before a response. It may already have consumed quota; no automatic retry was made.");
	}
	const raw = await readBody(response, response.ok ? MAX_RESPONSE_BYTES : 16 * 1024, requestSignal);
	let decoded: unknown;
	try { decoded = JSON.parse(raw); } catch { /* Never expose raw HTML or provider payloads. */ }
	if (!response.ok) {
		const detail = safeError(decoded, [auth.token, auth.accountId]);
		const hint = response.status === 401 ? " Sign in again with /login."
			: response.status === 429 ? " Subscription usage limit reached; wait for your quota to reset." : "";
		throw new Error(`Codex image generation returned HTTP ${response.status}.${hint}${detail ? ` ${detail}` : ""} No automatic retry was made.`);
	}
	const data = record(decoded);
	const item = Array.isArray(data?.data) ? record(data.data[0]) : undefined;
	if (typeof item?.b64_json !== "string" || !item.b64_json) throw new Error("Codex image response contains no image data.");
	const encoded = item.b64_json.trim();
	if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Generated image exceeds 32 MiB.");
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== encoded) throw new Error("Codex returned invalid or oversized base64 image data.");
	const dimensions = pngDimensions(bytes);
	// Once the backend returns an image, save it even if the user cancels immediately afterward.
	const outputPath = imageArtifactPath(dependencies.saveRoot ?? getAgentDir(), ctx.sessionManager.getSessionId(), toolCallId);
	const saved = await saveImage(outputPath, bytes);
	const output_hint = saved ? imageOutputHint(saved) : undefined;
	const usage = usageFromResponse(data?.usage);
	return {
		data: encoded,
		...(output_hint ? { output_hint } : {}),
		metadata: {
			...(saved ? { path: saved } : {}), input_images,
			...(data?.background === "transparent" ? { transparent_background: true } : data?.background === "opaque" ? { transparent_background: false } : {}),
			...(typeof item.generation_id === "string" ? { generation_id: item.generation_id } : {}),
			model: IMAGE_MODEL, auth: "subscription", operation, mimeType: "image/png",
			bytes: bytes.length, ...dimensions,
			...(typeof data?.quality === "string" ? { quality: data.quality } : {}),
			...(typeof data?.size === "string" ? { size: data.size } : {}),
			...(usage ? { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.totalTokens } : {}),
		},
		...(usage ? { usage } : {}),
	};
}
