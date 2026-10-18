import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  addedFile, buildPrompt, combineSnapshots, digest, fileKey, isWorkspace, MAX_REVIEW_FILES, parsePatch, repositoryReview, reviewNoteRepository, reviewSources, sourceForFile,
  type Annotation, type ChangedFile, type FileDiff, type PreparedReview, type ReviewSnapshot, type Snapshot,
} from "./model.ts";

import { MAX_REVIEW_PATHS } from "./paths.ts";

const MAX_FILES = MAX_REVIEW_FILES;
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

export async function collectReview(paths: readonly string[], signal?: AbortSignal, collect = collectSnapshot): Promise<ReviewSnapshot> {
  if (!paths.length || paths.length > MAX_REVIEW_PATHS) throw new Error(`Review between 1 and ${MAX_REVIEW_PATHS} paths at once.`);
  const snapshots: Snapshot[] = [];
  for (let i = 0; i < paths.length; i += 4) {
    snapshots.push(...await Promise.all(paths.slice(i, i + 4).map(async (path) => {
      try { return await collect(path, signal); }
      catch (error) {
        if (paths.length === 1 || signal?.aborted) throw error;
        throw new Error(`${JSON.stringify(path)}: ${(error as Error).message}`, { cause: error });
      }
    })));
  }
  return combineSnapshots(snapshots);
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

export async function loadFileDiff(snapshot: ReviewSnapshot, path: string, signal?: AbortSignal): Promise<FileDiff> {
  if (isWorkspace(snapshot)) {
    const file = snapshot.files.find((file) => fileKey(file) === path);
    if (!file) throw new Error("File is no longer in this diff. Press r to refresh.");
    const source = sourceForFile(snapshot, file);
    return { ...await loadFileDiff(source, file.path, signal), repository: source.root };
  }
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

export async function prepareReview(snapshot: ReviewSnapshot, annotations: Annotation[], signal?: AbortSignal): Promise<PreparedReview> {
  if (!annotations.length) throw new Error("Add at least one annotation before submitting.");
  const noteRepositories = new Map(annotations.map((note) => [note.id, note.scope === "review" ? reviewNoteRepository(snapshot, note)
    : sourceForFile(snapshot, { repository: note.repository, path: note.path! }).root]));
  const roots = new Set(noteRepositories.values());
  const sources = reviewSources(snapshot).filter((source) => roots.has(source.root));
  const selected = combineSnapshots(sources);
  const current = await collectReview(sources.map((source) => source.target), signal);
  const scopedReviews = new Map<string, ReviewSnapshot>();
  for (const root of new Set(noteRepositories.values())) {
    if (reviewSources(current).some((source) => source.root === root)) scopedReviews.set(root, repositoryReview(current, root));
  }
  const fingerprints = new Map<string, string>();
  const requested = new Map<string, { repository: string; path: string }>();
  for (const note of annotations) {
    if (!note.path) continue;
    const file = { repository: sourceForFile(snapshot, { repository: note.repository, path: note.path }).root, path: note.path };
    requested.set(fileKey(file), file);
  }
  for (const file of current.files) {
    const source = sourceForFile(current, file);
    const key = fileKey({ repository: source.root, path: file.path });
    if (requested.has(key)) fingerprints.set(key, (await loadFileDiff(current, fileKey(file), signal)).fingerprint);
  }
  const staleIds = annotations.filter((note) => {
    if (note.scope === "review") {
      const selected = scopedReviews.get(noteRepositories.get(note.id)!);
      return !selected || note.fingerprint !== selected.id || ((note.repository !== undefined || !isWorkspace(snapshot)) && note.base !== reviewSources(selected)[0].base);
    }
    const root = sourceForFile(snapshot, { repository: note.repository, path: note.path! }).root;
    const source = reviewSources(current).find((source) => source.root === root);
    return !source || note.base !== source.base || note.fingerprint !== fingerprints.get(fileKey({ repository: root, path: note.path! }));
  }).map((note) => note.id);
  return {
    prompt: buildPrompt(snapshot, annotations, staleIds),
    staleIds,
    treeChanged: current.id !== selected.id,
  };
}
