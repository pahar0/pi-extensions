# Codex-compatible image generation

Reference: [openai/codex at aef7d276](https://github.com/openai/codex/tree/aef7d276a4518ad9cb2805a8ddc634eef6f3e7dc/codex-rs/ext/image-generation), inspected 2026-11-02. This is a Pi implementation of Codex's image-tool contract, not a copy of its Rust code or complete application runtime.

## Mirrored behavior

- Exactly four arguments from `ImagegenArgs`: `prompt`, optional `transparent_background` (false by default), optional `referenced_image_paths` (up to five absolute paths), and optional `num_last_images_to_include` (1–5). The two optional reference selectors also accept null, like Rust Option fields. Unknown arguments are rejected.
- No size, quality, model, count, or destination-path arguments. The image model is `gpt-image-2`; both generation and editing always send `quality: "auto"` and `size: "auto"`. Prompts are passed verbatim.
- No references means generation. Nonempty paths mean local editing. A recent-image count means editing using exactly the last N visible images, returned to the backend in chronological order. Nonempty paths and a count cannot be combined; an empty path list does not block the count selector.
- Recent images include user attachments and image-bearing tool/custom messages. Pi's session projection honors the active branch, compaction and context edits. Only the selected image blocks are sent, never surrounding conversation text.
- Local PNG/JPEG/WebP data is preserved without resizing after decoding/validation. GIF and other supported formats are converted to PNG without resizing. Raw local input hashes are recorded in tool-result details.
- Requests use the active subscription's bearer token/account ID and the Codex `images/generations` or `images/edits` endpoint. The first returned image is used; optional actual background and generation ID are retained in details.
- Saved artifacts use `<Pi agent directory>/generated_images/<sanitized session ID>/<sanitized tool-call ID>.png`, analogous to Codex's home-directory artifact layout.
- The model/codemode result uses Codex's `{ image_url, output_hint? }` shape. The hint is omitted above 1024 UTF-8 bytes. Generation still succeeds and returns the image if saving fails. Copy project-bound assets from the artifact location rather than moving/deleting originals.

## Pi-specific integration and safeguards

- The existing Pi tool name stays `image_generate` (Codex calls its tool `image_gen.imagegen`). Pi's codemode displays results with `image(result.image_url)`, not Codex's `generatedImage(result)`.
- Pi resolves/refreshes OAuth and handles tool exposure, UI, session persistence and inline image blocks. This does not reproduce Codex's feature/plan/model-capability gating, attachment store, telemetry, or extension-item events.
- The artifact root is Pi's agent directory, not `CODEX_HOME`. Saving never overwrites an existing artifact. A collision/save error omits the saved path/hint while still returning the generated image.
- Redirects and automatic retries remain disabled to avoid credential forwarding and duplicate quota consumption. This differs from Codex's provider-configured HTTP retry layer. The Pi request has a five-minute deadline and supports cancellation.
- Local source files are limited to 20 MiB each, combined selected inputs to 40 MiB, individual prepared/context/output images to 32 MiB, and JSON responses to 48 MiB. Pi uses its image decoder rather than Rust's; conversion/metadata preservation can differ for formats requiring re-encoding.
- No credential-file or shell-startup-file reads, and no API-key fallback. Only first-party ChatGPT endpoints and Pi subscription OAuth are accepted. Usage counts toward the subscription; a reported zero API dollar cost does not mean unlimited usage.

Codex-derived guidance and output-hint wording are attributed under Apache-2.0; see `LICENSE.codex` and the upstream `NOTICE.codex`. The original Rust implementation is not bundled.

Protocol sources: `ext/image-generation/src/tool.rs`, `artifact.rs`, `backend.rs`, `codex-api/src/endpoint/images.rs`, `model-provider-info/src/lib.rs`, and `model-provider/src/bearer_auth_provider.rs`.

This backend is an internal Codex interface, not a stable public Images API. Server behavior, availability and quotas can change.
