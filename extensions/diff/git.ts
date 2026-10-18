import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  addedFile, buildPrompt, digest, parsePatch,
  type Annotation, type ChangedFile, type FileDiff, type PreparedReview, type Snapshot,
} from "./model.ts";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

/** No shell, pager, external diff driver, textconv, index refresh, or Git writes. */
function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_PATCH_BYTES,
      timeout: 20_000,
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_PAGER: "cat" },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim();
        if (detail) error.message = `${error.message.split("\n")[0]}: ${detail}`;
        reject(error);
      } else resolve(stdout);
    });
    child.stdin?.end();
  });
}

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}

async function fileStamp(root: string, path: string): Promise<string> {
  try {
    const stat = await lstat(join(root, path));
    return `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if (missing(error)) return "missing";
    throw error;
  }
}

async function head(root: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal)).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

/** Find an existing Git execution directory without losing a file/deleted-path filter. */
async function resolveTarget(path: string): Promise<{ directory: string; target: string }> {
  const requested = resolve(path);
  let ancestor = requested;
  for (;;) {
    try {
      const entry = await lstat(ancestor);
      if (entry.isDirectory()) break;
      if (ancestor !== requested) throw new Error("Review path crosses a non-directory.");
      // Directory aliases work like directories; file/broken links are reviewed as links.
      if (entry.isSymbolicLink() && (await stat(ancestor).catch(() => undefined))?.isDirectory()) break;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("No existing parent directory for the review path.");
    ancestor = parent;
  }
  const directory = await realpath(ancestor);
  return { directory, target: resolve(directory, relative(ancestor, requested)) };
}

export async function collectSnapshot(path: string, signal?: AbortSignal): Promise<Snapshot> {
  const { directory, target } = await resolveTarget(path);
  let root: string;
  try {
    root = await realpath((await git(directory, ["rev-parse", "--show-toplevel"], signal)).replace(/\r?\n$/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Git is not installed or is not on PATH.");
    throw new Error("/diff needs a Git working tree. Pass a path inside a repository.", { cause: error });
  }
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("Review path is outside the Git working tree.");
  const scope = local.split(sep).join("/") || ".";
  const base = await head(root, signal);
  const [tracked, untracked] = await Promise.all([
    base
      ? git(root, ["diff", "--name-status", "-z", "--no-renames", "--no-relative", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", base, "--", scope], signal)
      : git(root, ["ls-files", "--cached", "-z", "--", scope], signal),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope], signal),
  ]);
  const statuses = new Map<string, string>();
  if (base) {
    const fields = tracked.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) statuses.set(fields[i + 1], fields[i]);
  } else {
    for (const path of tracked.split("\0").filter(Boolean)) statuses.set(path, "A");
  }
  for (const path of untracked.split("\0").filter(Boolean)) statuses.set(path, "?");
  if (statuses.size > MAX_FILES) throw new Error(`More than ${MAX_FILES} changed files. Use /diff <narrower-path> to review them.`);
  const paths = [...statuses.keys()].sort();
  const files: ChangedFile[] = [];
  // Bound filesystem concurrency, even in repositories with thousands of changes.
  for (let i = 0; i < paths.length; i += 32) {
    const batch = await Promise.all(paths.slice(i, i + 32).map(async (path) => ({
      path, status: statuses.get(path)!, stamp: await fileStamp(root, path),
    })));
    files.push(...batch.filter((file) => base !== null || file.stamp !== "missing"));
  }
  if (await head(root, signal) !== base) throw new Error("HEAD changed while collecting the diff. Run /diff again.");
  return {
    root, target, scope, base, files,
    id: digest(base ?? "unborn", root, scope, JSON.stringify(files)),
  };
}

async function workingContent(root: string, path: string): Promise<{ fingerprint: string; text?: string; message?: string }> {
  const fullPath = join(root, path);
  try {
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) {
      const target = await readlink(fullPath);
      return { fingerprint: digest("symlink", target), text: target };
    }
    if (!stat.isFile()) return { fingerprint: digest("directory", await fileStamp(root, path)), message: "Submodule / directory change. Use a file-level note (f)." };
    if (stat.size > MAX_FILE_BYTES) return {
      fingerprint: digest("large", await fileStamp(root, path)),
      message: "File exceeds the 2 MiB text-preview limit. Use a file-level note (f).",
    };
    const bytes = await readFile(fullPath);
    const fingerprint = digest(String(stat.mode), bytes.toString("base64"));
    if (bytes.includes(0)) return { fingerprint, message: "Binary file changed. Use a file-level note (f)." };
    return { fingerprint, text: bytes.toString("utf8") };
  } catch (error) {
    if (missing(error)) return { fingerprint: "missing" };
    throw error;
  }
}

export async function loadFileDiff(snapshot: Snapshot, path: string, signal?: AbortSignal): Promise<FileDiff> {
  const file = snapshot.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error("File is no longer in this diff. Press r to refresh.");
  const before = await fileStamp(snapshot.root, path);
  const content = await workingContent(snapshot.root, path);
  let parsed: ReturnType<typeof parsePatch>;
  let patch = "";
  if (content.message) {
    // Submodule patches contain the commit ids; include them in the fingerprint.
    if (content.message.startsWith("Submodule") && snapshot.base) {
      patch = await git(snapshot.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=none", snapshot.base, "--", path], signal);
    }
    parsed = { rows: [], added: 0, removed: 0, message: [content.message, patch.trim()].filter(Boolean).join("\n\n") };
  } else if (file.status === "?" || !snapshot.base) {
    parsed = addedFile(content.text ?? "");
  } else {
    try {
      patch = await git(snapshot.root, [
        "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=none",
        "--unified=4", snapshot.base, "--", path,
      ], signal);
      parsed = parsePatch(patch);
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      parsed = { rows: [], added: 0, removed: 0, message: "Diff exceeds the 8 MiB preview limit. Use a file-level note (f)." };
    }
  }
  if (await fileStamp(snapshot.root, path) !== before) throw new Error("File changed while loading. Press r to refresh before commenting.");
  return { path, fingerprint: digest(snapshot.base ?? "unborn", path, content.fingerprint, patch), ...parsed };
}

export async function prepareReview(snapshot: Snapshot, annotations: Annotation[], signal?: AbortSignal): Promise<PreparedReview> {
  const current = await collectSnapshot(snapshot.target, signal);
  const fingerprints = new Map<string, string>();
  const paths = [...new Set(annotations.flatMap((note) => note.path ? [note.path] : []))];
  for (const path of paths) {
    if (current.files.some((file) => file.path === path)) {
      fingerprints.set(path, (await loadFileDiff(current, path, signal)).fingerprint);
    }
  }
  const staleIds = annotations.filter((note) => note.base !== current.base || (note.scope === "review"
    ? note.fingerprint !== current.id
    : note.fingerprint !== fingerprints.get(note.path!))).map((note) => note.id);
  return {
    prompt: buildPrompt(snapshot, annotations, staleIds),
    staleIds,
    treeChanged: current.id !== snapshot.id,
  };
}
