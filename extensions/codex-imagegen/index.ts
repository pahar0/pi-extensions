// Codex tool schema/guidance adapted for Pi. Copyright 2025 OpenAI.
// Apache-2.0; see LICENSE.codex, NOTICE.codex and UPSTREAM.md.
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateImage, type ImageDependencies } from "./client.ts";

export default function codexImagegen(pi: ExtensionAPI, dependencies: ImageDependencies = {}) {
	pi.registerTool(defineTool({
		// Keep the existing Pi tool name; Codex calls its equivalent image_gen.imagegen.
		name: "image_generate",
		label: "Codex Image Generation",
		namespace: { name: "image_gen", description: "Codex-compatible subscription image generation and editing." },
		description: "Generate images from descriptions or edit existing images, mirroring Codex's image_gen.imagegen tool. Uses the ChatGPT/Codex subscription, never an API key. The model is gpt-image-2; size and quality are always auto. Takes several minutes. Returns image_url and, when saved, output_hint. Consumes subscription quota; never automatically retry a failed generation.",
		promptSnippet: "Codex-compatible image generation/editing using the existing ChatGPT subscription.",
		promptGuidelines: [
			"Use image_generate when the user requests an image or asks to modify an attached or previously generated image. Generate directly without reconfirmation unless required images must be attached again.",
			"For a brand new image, omit both referenced_image_paths and num_last_images_to_include. For edits, use referenced_image_paths when every target has an absolute local path; inspect unseen local targets with read first.",
			"Use num_last_images_to_include only when at least one target has no local path. Select the smallest count of recent conversation images that includes every target, up to five. Never provide both reference mechanisms; ask for missing images to be attached again.",
			"Set transparent_background=true for transparent backgrounds or cutouts; otherwise false. For edits, preserve existing transparency unless asked to change it. Use this tool for image editing, not Python, unless the user explicitly requests otherwise.",
			"In codemode, allow several minutes and display the result with image(result.image_url). Never print the full result or base64 image data with text() or console.log().",
			"Artifacts are saved by session/call ID under Pi's generated_images directory. Copy selected project assets into the project, leaving originals in place unless deletion was requested. Never silently fall back to an API key.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Image description, or exact editing instructions and invariants to preserve." }),
			transparent_background: Type.Optional(Type.Boolean({ description: "Whether the output should have a transparent background. Defaults to false." })),
			referenced_image_paths: Type.Optional(Type.Union([
				Type.Array(Type.String({ description: "Absolute local image path." }), { maxItems: 5 }),
				Type.Null(),
			], { description: "Up to five absolute local image paths for editing. Cannot be combined with num_last_images_to_include." })),
			num_last_images_to_include: Type.Optional(Type.Union([
				Type.Integer({ minimum: 1, maximum: 5 }), Type.Null(),
			], { description: "Edit using the last 1–5 images in the current conversation, in chronological order. Use only when a target has no local path." })),
		}, { additionalProperties: false }),
		outputSchema: Type.Object({
			image_url: Type.String(),
			output_hint: Type.Optional(Type.String()),
		}, { additionalProperties: false }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Generating/editing image with the Codex subscription…" }], details: undefined });
			const result = await generateImage(toolCallId, params, ctx, signal, dependencies);
			const image_url = `data:image/png;base64,${result.data}`;
			return {
				content: [
					{ type: "image", data: result.data, mimeType: "image/png" },
					...(result.output_hint ? [{ type: "text" as const, text: result.output_hint }] : []),
				],
				details: result.metadata,
				structuredContent: { image_url, ...(result.output_hint ? { output_hint: result.output_hint } : {}) },
				...(result.usage ? { usage: result.usage } : {}),
			};
		},
	}));
}
