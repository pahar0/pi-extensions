// Codex image-tool argument/reference behavior adapted to Pi sessions and image decoding.
// Copyright 2025 OpenAI. Apache-2.0; see LICENSE.codex, NOTICE.codex and UPSTREAM.md.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { convertToPng, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_EDIT_IMAGES = 5;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 40 * 1024 * 1024;
const MAX_CONTEXT_IMAGE_BYTES = 32 * 1024 * 1024;

/** Mirrors Codex's ImagegenArgs, including nullable Option fields. */
export interface ImageParams {
	prompt: string;
	transparent_background?: boolean;
	referenced_image_paths?: string[] | null;
	num_last_images_to_include?: number | null;
}

export interface InputImageIdentity { path: string; sha256: string }
export interface ImageReference { image_url: string }
export interface PreparedImages { images: ImageReference[]; input_images: InputImageIdentity[] }

type ImageContext = Pick<ExtensionContext, "sessionManager">;

function validateArgs(params: ImageParams): void {
	const allowed = new Set(["prompt", "transparent_background", "referenced_image_paths", "num_last_images_to_include"]);
	if (!params || typeof params !== "object" || typeof params.prompt !== "string") throw new Error("prompt must be a string.");
	for (const key of Object.keys(params)) if (!allowed.has(key)) throw new Error(`Unknown imagegen argument: ${key}.`);
	if (params.transparent_background !== undefined && typeof params.transparent_background !== "boolean") throw new Error("transparent_background must be a boolean.");
	const paths = params.referenced_image_paths ?? [];
	if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
		throw new Error("referenced_image_paths must contain absolute filesystem paths, not URLs or relative paths.");
	}
	if (paths.length > MAX_EDIT_IMAGES) throw new Error(`referenced_image_paths must contain at most ${MAX_EDIT_IMAGES} paths.`);
	const count = params.num_last_images_to_include;
	if (count != null && (!Number.isInteger(count) || count < 1 || count > MAX_EDIT_IMAGES)) {
		throw new Error(`num_last_images_to_include must be between 1 and ${MAX_EDIT_IMAGES}.`);
	}
	if (paths.length && count != null) throw new Error("Provide only one of referenced_image_paths or num_last_images_to_include.");
}

async function readImage(path: string, signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("Reference images must be regular files of at most 20 MiB each.");
		const chunks: Buffer[] = [];
		let length = 0;
		for (;;) {
			signal.throwIfAborted();
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - length));
			const { bytesRead } = await file.read(chunk);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > MAX_INPUT_BYTES) throw new Error("A reference image exceeds 20 MiB.");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks);
	} finally { await file.close(); }
}

function preservedMime(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return undefined;
}

async function prepareLocalImages(paths: string[], signal: AbortSignal): Promise<PreparedImages> {
	const images: ImageReference[] = [], input_images: InputImageIdentity[] = [];
	let total = 0;
	for (const path of paths) {
		const bytes = await readImage(path, signal);
		total += bytes.length;
		if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("Reference images exceed the combined 40 MiB limit.");
		const encoded = bytes.toString("base64");
		// Codex decodes local images in Original mode: preserve PNG/JPEG/WebP bytes,
		// and convert GIF/other supported image formats to PNG without resizing.
		const decoded = await convertToPng(encoded, "application/octet-stream");
		signal.throwIfAborted();
		if (!decoded) throw new Error(`Unable to decode referenced image at ${path}.`);
		if (Buffer.byteLength(decoded.data, "base64") > MAX_CONTEXT_IMAGE_BYTES) throw new Error("Prepared reference image exceeds 32 MiB.");
		const mime = preservedMime(bytes);
		images.push({ image_url: `data:${mime ?? decoded.mimeType};base64,${mime ? encoded : decoded.data}` });
		input_images.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
	}
	return { images, input_images };
}

function recentImages(ctx: ImageContext, count: number): ImageReference[] {
	const selected: { data: string; mimeType: string }[] = [];
	// Unlike raw getEntries()/getBranch(), this respects branches, compaction and
	// context edits. Do not resurrect images the model can no longer see.
	const messages = ctx.sessionManager.buildSessionProjection().messages;
	outer: for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") continue;
		if (!Array.isArray(message.content)) continue;
		for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = message.content[blockIndex]!;
			if (block.type === "image") {
				selected.push(block);
				if (selected.length === count) break outer;
			}
		}
	}
	if (selected.length !== count) {
		throw new Error(`Requested the last ${count} conversation images, but only ${selected.length} were available.`);
	}
	let total = 0;
	return selected.reverse().map((image) => {
		const encoded = image.data.trim();
		if (encoded.length > Math.ceil(MAX_CONTEXT_IMAGE_BYTES / 3) * 4) throw new Error("Conversation image exceeds 32 MiB.");
		const bytes = Buffer.from(encoded, "base64");
		if (!bytes.length || bytes.toString("base64") !== encoded) throw new Error("Conversation image contains invalid base64 data.");
		total += bytes.length;
		if (total > MAX_TOTAL_INPUT_BYTES) throw new Error("Selected conversation images exceed the combined 40 MiB limit.");
		return { image_url: `data:${image.mimeType};base64,${encoded}` };
	});
}

export async function prepareImages(params: ImageParams, ctx: ImageContext, signal: AbortSignal): Promise<PreparedImages> {
	signal.throwIfAborted();
	validateArgs(params);
	const paths = params.referenced_image_paths ?? [];
	if (paths.length) return prepareLocalImages(paths, signal);
	if (params.num_last_images_to_include != null) {
		return { images: recentImages(ctx, params.num_last_images_to_include), input_images: [] };
	}
	return { images: [], input_images: [] };
}
