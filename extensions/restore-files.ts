// Last verified working with Pi v0.78.1
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

type BackupRef = string | null;

type Snapshot = {
  entryId: string;
  timestamp: number;
  files: Record<string, BackupRef>; // key: relative path from ctx.cwd
};

type PersistedSnapshotEntry = {
  snapshot: Snapshot;
};

type TextBlockLike = { type?: string; text?: unknown };
type MessageLike = {
  role?: string;
  content?: unknown;
};

type SessionMessageEntryLike = {
  type: "message";
  id: string;
  message?: MessageLike;
};

type SessionCustomEntryLike = {
  type: "custom";
  customType?: string;
  data?: unknown;
};

type SessionEntryLike = SessionMessageEntryLike | SessionCustomEntryLike | { type?: string; id?: string };

type SessionManagerLike = {
  getBranch?: () => SessionEntryLike[];
  getEntry?: (id: string) => SessionEntryLike | undefined;
  getSessionFile?: () => string | undefined;
};

type UIContextLike = {
  notify: (message: string, type?: "info" | "warning" | "error" | "success") => void;
  confirm: (title: string, message: string) => Promise<boolean>;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  custom?: <T>(
    create: (tui: any, theme: any, keybindings: any, done: (value: T | undefined) => void) => {
      invalidate?: () => void;
      handleInput?: (data: string) => void;
      render: (width: number) => string[];
    },
    options?: unknown,
  ) => Promise<T | undefined>;
};

type BaseContextLike = {
  cwd: string;
  hasUI: boolean;
  mode?: "tui" | "rpc" | "json" | "print";
  ui: UIContextLike;
  sessionManager: SessionManagerLike;
};

type CommandContextLike = BaseContextLike & {
  waitForIdle: () => Promise<void>;
  navigateTree: (targetId: string, options?: unknown) => Promise<unknown>;
};

type ToolCallEventLike = {
  toolName: string;
  input: unknown;
};

type SessionBeforeTreeEventLike = {
  preparation: {
    targetId: string;
  };
};

const SNAPSHOT_CUSTOM_TYPE = "rewind-file-snapshot-v1";
const MAX_SNAPSHOTS = 100;

// Safety defaults
// When true, track and restore files even if they are outside ctx.cwd.
const ALLOW_OUTSIDE_CWD = true;

function isWithinCwd(cwd: string, absPath: string): boolean {
  const rel = relative(cwd, absPath);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function relKey(cwd: string, inputPath: string): Promise<string | null> {
  const abs = await canonicalPath(resolve(cwd, inputPath));
  if (!ALLOW_OUTSIDE_CWD && !isWithinCwd(cwd, abs)) return null;
  const rel = relative(cwd, abs);
  return rel === "" ? null : rel;
}

function absPath(cwd: string, key: string): string {
  return isAbsolute(key) ? key : resolve(cwd, key);
}

async function normalizeStoredFileKey(cwd: string, key: string): Promise<string | null> {
  const abs = await canonicalPath(absPath(cwd, key));
  if (!ALLOW_OUTSIDE_CWD && !isWithinCwd(cwd, abs)) return null;
  const rel = relative(cwd, abs);
  return rel === "" ? null : rel;
}

function textFromUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object" && (block as TextBlockLike).type === "text") {
      return String((block as TextBlockLike).text ?? "");
    }
  }
  return "";
}

function isSelectableUserMessageEntry(entry: SessionEntryLike | undefined): entry is SessionMessageEntryLike {
  if (!entry || entry.type !== "message") return false;
  if (entry.message?.role !== "user") return false;
  const text = textFromUserContent(entry.message.content).trim();
  if (text.startsWith("/")) return false;
  return true;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatShortTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-- -- --:--";
  const d = new Date(timestamp);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function formatDisplayPath(cwd: string, fileKey: string): string {
  const absolute = resolve(cwd, fileKey);
  const home = homedir();
  if (absolute === home) return "~";
  if (absolute.startsWith(`${home}${sep}`)) {
    return `~/${relative(home, absolute)}`;
  }
  return absolute;
}

function truncatePlain(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

type RestoreAction = "both" | "conversation" | "code" | "cancel";
type TreeNavigationAction = "both" | "conversation" | "cancel";

async function chooseRestoreAction(
  ctx: BaseContextLike,
  entryId: string,
  changeCount: number,
): Promise<RestoreAction> {
  const fileLabel = `${changeCount} file${changeCount === 1 ? "" : "s"}`;
  const options =
    changeCount > 0
      ? [
          { label: `Restore code and conversation (${fileLabel})`, value: "both" as const },
          { label: "Restore conversation", value: "conversation" as const },
          { label: `Restore code (${fileLabel})`, value: "code" as const },
          { label: "Cancel", value: "cancel" as const },
        ]
      : [
          { label: "Restore conversation", value: "conversation" as const },
          { label: "Cancel", value: "cancel" as const },
        ];

  const picked = await ctx.ui.select(
    `Checkpoint ${shortId(entryId)}${changeCount > 0 ? ` • ${fileLabel} can be restored` : ""}`,
    options.map((option) => option.label),
  );

  return options.find((option) => option.label === picked)?.value ?? "cancel";
}

async function chooseTreeNavigationAction(
  ctx: BaseContextLike,
  entryId: string,
  changeCount: number,
): Promise<TreeNavigationAction> {
  const fileLabel = `${changeCount} file${changeCount === 1 ? "" : "s"}`;
  const options = [
    { label: `Restore code and conversation (${fileLabel})`, value: "both" as const },
    { label: "Restore conversation", value: "conversation" as const },
    { label: "Cancel", value: "cancel" as const },
  ];

  const picked = await ctx.ui.select(
    `Navigate to checkpoint ${shortId(entryId)} • ${fileLabel} can be restored`,
    options.map((option) => option.label),
  );

  return options.find((option) => option.label === picked)?.value ?? "cancel";
}

function extractToolTargetPaths(toolName: string, input: unknown): string[] {
  const i = (input && typeof input === "object" ? (input as Record<string, unknown>) : {}) as Record<string, unknown>;
  const p = i.path ?? i.file_path;
  if (toolName === "write" || toolName === "edit") {
    return typeof p === "string" ? [p] : [];
  }
  return [];
}

export default function (pi: ExtensionAPI) {
  let snapshots: Snapshot[] = [];
  let trackedFiles = new Set<string>();
  const nextVersion = new Map<string, number>(); // per-file version counter
  const dirtySnapshotEntryIds = new Set<string>();
  let pendingTreeRestoreTargetId: string | null = null;
  let programmaticTreeNavigationChoice: { targetId: string; restoreFiles: boolean } | null = null;
  let backupSessionKey = "ephemeral";

  let queue: Promise<void> = Promise.resolve();
  function enqueue(op: () => Promise<void>): Promise<void> {
    queue = queue.then(op, op);
    return queue;
  }

  function notifyWarning(ctx: BaseContextLike | undefined, message: string): void {
    if (ctx?.hasUI) {
      ctx.ui.notify(message, "warning");
    }
  }

  function getBackupSessionKey(ctx: BaseContextLike): string {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    const source = sessionFile ? resolve(String(sessionFile)) : `ephemeral:${ctx.cwd}`;
    return createHash("sha256").update(source).digest("hex").slice(0, 12);
  }

  function backupRoot(_cwd: string): string {
    const piAgentDir = process.env.PI_CODING_AGENT_DIR
      ? resolve(process.env.PI_CODING_AGENT_DIR)
      : resolve(homedir(), ".pi", "agent");
    return resolve(piAgentDir, "state", "file-history", "backups", backupSessionKey);
  }

  function backupName(fileKey: string, version: number): string {
    const hash = createHash("sha256").update(fileKey).digest("hex").slice(0, 16);
    return `${hash}@v${version}`;
  }

  function backupPath(cwd: string, ref: string): string {
    return resolve(backupRoot(cwd), ref);
  }

  function currentVersion(fileKey: string): number {
    return nextVersion.get(fileKey) ?? 0;
  }

  function bumpVersion(fileKey: string): number {
    const v = currentVersion(fileKey) + 1;
    nextVersion.set(fileKey, v);
    return v;
  }

  function markSnapshotDirty(entryId: string): void {
    dirtySnapshotEntryIds.add(entryId);
  }

  function getReferencedBackupRefs(): Set<string> {
    const refs = new Set<string>();
    for (const snapshot of snapshots) {
      for (const ref of Object.values(snapshot.files)) {
        if (typeof ref === "string") refs.add(ref);
      }
    }
    return refs;
  }

  async function pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async function hashFileSha256(path: string): Promise<string> {
    return await new Promise<string>((resolveHash, rejectHash) => {
      const hash = createHash("sha256");
      const stream = createReadStream(path);
      stream.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      stream.on("error", rejectHash);
      stream.on("end", () => resolveHash(hash.digest("hex")));
    });
  }

  async function createBackup(cwd: string, fileKey: string): Promise<BackupRef> {
    const source = absPath(cwd, fileKey);
    if (!(await pathExists(source))) {
      return null;
    }

    const version = bumpVersion(fileKey);
    const ref = backupName(fileKey, version);
    const dest = backupPath(cwd, ref);

    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);

    try {
      const st = await stat(source);
      await chmod(dest, st.mode);
    } catch {
      // best effort
    }

    return ref;
  }

  async function filesEqual(currentPath: string, backupFilePath: string): Promise<boolean> {
    try {
      const [aStat, bStat] = await Promise.all([stat(currentPath), stat(backupFilePath)]);
      if (aStat.mode !== bStat.mode || aStat.size !== bStat.size) return false;
      if (aStat.size === 0) return true;

      const [aHash, bHash] = await Promise.all([hashFileSha256(currentPath), hashFileSha256(backupFilePath)]);
      return aHash === bHash;
    } catch {
      return false;
    }
  }

  function getLastSnapshot(): Snapshot | undefined {
    return snapshots[snapshots.length - 1];
  }

  function getSnapshotByEntryId(entryId: string): Snapshot | undefined {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i]?.entryId === entryId) return snapshots[i];
    }
    return undefined;
  }

  function latestSelectableUserEntry(ctx: BaseContextLike): SessionMessageEntryLike | undefined {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (isSelectableUserMessageEntry(entry)) return entry;
    }
    return undefined;
  }

  function rebuildIndicesFromSnapshots(): void {
    trackedFiles = new Set<string>();
    nextVersion.clear();

    for (const snap of snapshots) {
      for (const [fileKey, ref] of Object.entries(snap.files)) {
        trackedFiles.add(fileKey);
        if (typeof ref === "string") {
          const m = /@v(\d+)$/.exec(ref);
          if (m) {
            const parsed = Number(m[1]);
            if (Number.isFinite(parsed) && parsed > currentVersion(fileKey)) {
              nextVersion.set(fileKey, parsed);
            }
          }
        }
      }
    }
  }

  function backfillMissingSnapshotFileStatesForUx(): void {
    const firstKnownByFile = new Map<string, BackupRef>();

    for (const snapshot of snapshots) {
      for (const [fileKey, ref] of Object.entries(snapshot.files)) {
        if (!firstKnownByFile.has(fileKey)) {
          firstKnownByFile.set(fileKey, ref);
        }
      }
    }

    for (const snapshot of snapshots) {
      let changed = false;
      for (const [fileKey, firstKnownRef] of firstKnownByFile.entries()) {
        if (fileKey in snapshot.files) continue;
        snapshot.files[fileKey] = firstKnownRef;
        changed = true;
      }
      if (changed) markSnapshotDirty(snapshot.entryId);
    }
  }

  async function flushDirtySnapshots(): Promise<void> {
    if (dirtySnapshotEntryIds.size === 0) return;

    const ids = Array.from(dirtySnapshotEntryIds);
    dirtySnapshotEntryIds.clear();

    for (const entryId of ids) {
      const snapshot = getSnapshotByEntryId(entryId);
      if (!snapshot) continue;

      const entry: PersistedSnapshotEntry = { snapshot };
      pi.appendEntry(SNAPSHOT_CUSTOM_TYPE, entry);
    }
  }

  async function pruneOrphanBackups(ctx: BaseContextLike): Promise<void> {
    const root = backupRoot(ctx.cwd);
    if (!(await pathExists(root))) return;

    const keepRefs = getReferencedBackupRefs();

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (keepRefs.has(entry.name)) continue;

      const filePath = resolve(root, entry.name);
      try {
        await unlink(filePath);
      } catch {
        notifyWarning(ctx, `Failed to prune old backup: ${entry.name}`);
      }
    }
  }

  async function initializeFromSession(ctx: BaseContextLike): Promise<void> {
    snapshots = [];
    trackedFiles = new Set<string>();
    nextVersion.clear();
    dirtySnapshotEntryIds.clear();

    const branch = ctx.sessionManager.getBranch?.() ?? [];
    for (const entry of branch) {
      if (entry?.type !== "custom") continue;
      const customEntry = entry as SessionCustomEntryLike;
      if (customEntry.customType !== SNAPSHOT_CUSTOM_TYPE) continue;

      const data = customEntry.data as PersistedSnapshotEntry | undefined;
      const snap = data?.snapshot;
      if (!snap?.entryId || !snap?.files) continue;

      // Normalize keys and enforce path safety during restore
      const normalizedFiles: Record<string, BackupRef> = {};
      for (const [fileKey, ref] of Object.entries(snap.files)) {
        const normalized = await normalizeStoredFileKey(ctx.cwd, fileKey);
        if (!normalized) continue;
        normalizedFiles[normalized] = ref;
      }

      const normalizedSnapshot: Snapshot = {
        ...snap,
        files: normalizedFiles,
      };

      // last-wins for same entryId
      const idx = snapshots.findIndex((s) => s.entryId === snap.entryId);
      if (idx >= 0) snapshots[idx] = normalizedSnapshot;
      else snapshots.push(normalizedSnapshot);
    }

    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(-MAX_SNAPSHOTS);
    }

    backfillMissingSnapshotFileStatesForUx();
    rebuildIndicesFromSnapshots();
    await pruneOrphanBackups(ctx);
  }

  async function ensureCheckpointForCurrentTurn(ctx: BaseContextLike): Promise<void> {
    const userEntry = latestSelectableUserEntry(ctx);
    if (!userEntry) return;

    const existing = getSnapshotByEntryId(userEntry.id);
    if (existing) return;

    const previous = getLastSnapshot();
    const files: Record<string, BackupRef> = {};

    for (const fileKey of trackedFiles) {
      const previousRef = previous?.files[fileKey];
      const file = absPath(ctx.cwd, fileKey);
      const exists = await pathExists(file);

      if (!exists) {
        files[fileKey] = null;
        continue;
      }

      if (typeof previousRef === "string") {
        const previousBackup = backupPath(ctx.cwd, previousRef);
        if (await pathExists(previousBackup)) {
          const same = await filesEqual(file, previousBackup);
          if (same) {
            files[fileKey] = previousRef;
            continue;
          }
        }
      }

      files[fileKey] = await createBackup(ctx.cwd, fileKey);
    }

    const snapshot: Snapshot = {
      entryId: userEntry.id,
      timestamp: Date.now(),
      files,
    };

    snapshots.push(snapshot);
    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(-MAX_SNAPSHOTS);
      rebuildIndicesFromSnapshots();
      await pruneOrphanBackups(ctx);
    }

    markSnapshotDirty(snapshot.entryId);
  }

  async function trackFileBeforeMutation(ctx: BaseContextLike, rawPath: string): Promise<void> {
    const fileKey = await relKey(ctx.cwd, rawPath);
    if (!fileKey) {
      return;
    }

    trackedFiles.add(fileKey);

    const snapshot = getLastSnapshot();
    if (!snapshot) return;
    if (fileKey in snapshot.files) return;

    const initialRef = await createBackup(ctx.cwd, fileKey);
    snapshot.files[fileKey] = initialRef;
    markSnapshotDirty(snapshot.entryId);

    for (const previousSnapshot of snapshots) {
      if (previousSnapshot === snapshot) continue;
      if (fileKey in previousSnapshot.files) continue;
      previousSnapshot.files[fileKey] = initialRef;
      markSnapshotDirty(previousSnapshot.entryId);
    }
  }

  type SnapshotWouldChangeCache = Map<string, boolean>;

  async function wouldRestoreChangeFile(
    ctx: BaseContextLike,
    fileKey: string,
    desired: BackupRef,
    cache?: SnapshotWouldChangeCache,
  ): Promise<boolean> {
    const cacheKey = `${fileKey}::${desired === null ? "__null__" : desired}`;
    if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? false;

    const file = absPath(ctx.cwd, fileKey);
    if (!ALLOW_OUTSIDE_CWD && !isWithinCwd(ctx.cwd, file)) {
      cache?.set(cacheKey, false);
      return false;
    }

    let changed = false;
    if (desired === null) {
      changed = await pathExists(file);
    } else if (typeof desired === "string") {
      const backup = backupPath(ctx.cwd, desired);
      if (await pathExists(backup)) {
        if (!(await pathExists(file))) changed = true;
        else changed = !(await filesEqual(file, backup));
      }
    }

    cache?.set(cacheKey, changed);
    return changed;
  }

  async function countSnapshotChanges(
    ctx: BaseContextLike,
    target: Snapshot,
    cache?: SnapshotWouldChangeCache,
  ): Promise<number> {
    let changedCount = 0;

    for (const fileKey of trackedFiles) {
      const desired = target.files[fileKey];
      if (desired === undefined) continue;

      const changed = await wouldRestoreChangeFile(ctx, fileKey, desired, cache);
      if (changed) changedCount++;
    }

    return changedCount;
  }

  async function listSnapshotChanges(
    ctx: BaseContextLike,
    target: Snapshot,
    cache?: SnapshotWouldChangeCache,
  ): Promise<string[]> {
    const changedFiles: string[] = [];

    for (const fileKey of trackedFiles) {
      const desired = target.files[fileKey];
      if (desired === undefined) continue;

      const changed = await wouldRestoreChangeFile(ctx, fileKey, desired, cache);
      if (changed) changedFiles.push(formatDisplayPath(ctx.cwd, fileKey));
    }

    return changedFiles.sort((a, b) => a.localeCompare(b));
  }

  async function restoreSnapshot(ctx: BaseContextLike, target: Snapshot): Promise<number> {
    let changed = 0;

    for (const fileKey of trackedFiles) {
      const desired = target.files[fileKey];
      if (desired === undefined) continue;

      const file = absPath(ctx.cwd, fileKey);
      if (!ALLOW_OUTSIDE_CWD && !isWithinCwd(ctx.cwd, file)) continue;

      if (desired === null) {
        try {
          await unlink(file);
          changed++;
        } catch {
          // already missing or not removable
        }
        continue;
      }

      const backup = backupPath(ctx.cwd, desired);
      if (!(await pathExists(backup))) {
        notifyWarning(ctx, `Missing backup for ${fileKey}: ${desired}`);
        continue;
      }

      const alreadySame = (await pathExists(file)) && (await filesEqual(file, backup));
      if (alreadySame) continue;

      try {
        await mkdir(dirname(file), { recursive: true });
        await copyFile(backup, file);
        try {
          const st = await stat(backup);
          await chmod(file, st.mode);
        } catch {
          // best effort
        }
        changed++;
      } catch {
        notifyWarning(ctx, `Failed to restore file: ${fileKey}`);
      }
    }

    return changed;
  }

  pi.on("session_start", async (_event, ctx) => {
    await enqueue(async () => {
      pendingTreeRestoreTargetId = null;
      programmaticTreeNavigationChoice = null;
      backupSessionKey = getBackupSessionKey(ctx as BaseContextLike);
      await initializeFromSession(ctx as BaseContextLike);
    });
  });

  pi.on("turn_start", async (_event, ctx) => {
    await enqueue(async () => {
      await ensureCheckpointForCurrentTurn(ctx as BaseContextLike);
    });
  });

  pi.on("turn_end", async (_event, _ctx) => {
    await enqueue(async () => {
      await flushDirtySnapshots();
    });
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await enqueue(async () => {
      await flushDirtySnapshots();
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    const toolEvent = event as ToolCallEventLike;
    const paths = extractToolTargetPaths(toolEvent.toolName, toolEvent.input);
    if (paths.length === 0) return;

    await enqueue(async () => {
      // Ensure there is a checkpoint for this turn before first mutation.
      await ensureCheckpointForCurrentTurn(ctx as BaseContextLike);
      for (const p of paths) {
        await trackFileBeforeMutation(ctx as BaseContextLike, p);
      }
    });
  });

  pi.on("session_before_tree", async (event, ctx) => {
    pendingTreeRestoreTargetId = null;

    const treeEvent = event as SessionBeforeTreeEventLike;
    const targetId = treeEvent.preparation.targetId;

    if (programmaticTreeNavigationChoice?.targetId === targetId) {
      pendingTreeRestoreTargetId = programmaticTreeNavigationChoice.restoreFiles ? targetId : null;
      programmaticTreeNavigationChoice = null;
      return;
    }
    programmaticTreeNavigationChoice = null;

    if (ctx.mode !== "tui") return;

    const targetEntry = (ctx as BaseContextLike).sessionManager.getEntry?.(targetId);
    if (!isSelectableUserMessageEntry(targetEntry)) return;

    const targetSnapshot = getSnapshotByEntryId(targetId);
    if (!targetSnapshot) return;

    const changeCount = await countSnapshotChanges(ctx as BaseContextLike, targetSnapshot);
    if (changeCount === 0) return;

    const action = await chooseTreeNavigationAction(ctx as BaseContextLike, targetId, changeCount);
    if (action === "cancel") {
      return { cancel: true };
    }
    if (action === "both") {
      pendingTreeRestoreTargetId = targetId;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const targetId = pendingTreeRestoreTargetId;
    pendingTreeRestoreTargetId = null;
    if (!targetId) return;

    await enqueue(async () => {
      const targetSnapshot = getSnapshotByEntryId(targetId);
      if (!targetSnapshot) return;
      const changed = await restoreSnapshot(ctx as BaseContextLike, targetSnapshot);
      (ctx as BaseContextLike).ui.notify(
        `Restored ${changed} file${changed === 1 ? "" : "s"} from checkpoint ${shortId(targetId)}.`,
        "success",
      );
    });
  });

  pi.registerCommand("restore-files", {
    description: "Restore files to a previous user-message checkpoint",
    handler: async (args, ctx) => {
      const commandCtx = ctx as CommandContextLike;
      await commandCtx.waitForIdle();

      await enqueue(async () => {
        if (snapshots.length === 0) {
          commandCtx.ui.notify("No file checkpoints exist yet.", "warning");
          return;
        }

        const branch = commandCtx.sessionManager.getBranch?.() ?? [];
        const selectable = branch.filter(
          (e): e is SessionMessageEntryLike =>
            isSelectableUserMessageEntry(e) && Boolean(e.id && getSnapshotByEntryId(e.id)),
        );

        if (selectable.length === 0) {
          commandCtx.ui.notify("No rewindable user-message checkpoints found.", "warning");
          return;
        }

        let targetEntry: SessionMessageEntryLike | undefined;
        const raw = (args ?? "").trim();
        const compareCache: SnapshotWouldChangeCache = new Map();

        if (raw) {
          targetEntry = selectable.find((e) => e.id === raw || e.id.startsWith(raw));
          if (!targetEntry) {
            commandCtx.ui.notify(`No checkpoint matching '${raw}'.`, "error");
            return;
          }

          const targetSnapshot = getSnapshotByEntryId(targetEntry.id);
          if (!targetSnapshot) {
            commandCtx.ui.notify("Checkpoint snapshot missing.", "error");
            return;
          }

          const changeCount = await countSnapshotChanges(commandCtx, targetSnapshot, compareCache);
          if (changeCount === 0 && !commandCtx.hasUI) {
            commandCtx.ui.notify("Selected checkpoint has no restorable file changes.", "warning");
            return;
          }
        } else {
          if (commandCtx.mode !== "tui") {
            if (commandCtx.hasUI) commandCtx.ui.notify("Use: /restore-files <entry-id>", "error");
            return;
          }

          const actionableRows: Array<{
            entry: SessionMessageEntryLike;
            timeLabel: string;
            preview: string;
            countLabel: string;
            shortEntryId: string;
            files: string[];
          }> = [];

          for (const e of selectable.slice().reverse()) {
            const snap = getSnapshotByEntryId(e.id);
            if (!snap) continue;
            const changedFiles = await listSnapshotChanges(commandCtx, snap, compareCache);
            if (changedFiles.length === 0) continue;

            const text = textFromUserContent(e.message?.content).replace(/\s+/g, " ").trim();
            const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
            actionableRows.push({
              entry: e,
              timeLabel: formatShortTimestamp(snap.timestamp),
              preview: preview || "(no text)",
              countLabel: `(${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"})`,
              shortEntryId: shortId(e.id),
              files: changedFiles,
            });
          }

          if (actionableRows.length === 0) {
            commandCtx.ui.notify("No checkpoints with restorable file changes found.", "warning");
            return;
          }

          const timeWidth = Math.max(...actionableRows.map((row) => row.timeLabel.length));
          const previewWidth = Math.max(...actionableRows.map((row) => row.preview.length));
          const countWidth = Math.max(...actionableRows.map((row) => row.countLabel.length));

          const actionable: Array<{ entry: SessionMessageEntryLike; label: string; files: string[] }> =
            actionableRows.map((row) => ({
              entry: row.entry,
              label: `${row.timeLabel.padEnd(timeWidth)}  ${row.preview.padEnd(previewWidth)}  ${row.countLabel.padEnd(countWidth)}  ${row.shortEntryId}`,
              files: row.files,
            }));

          if (commandCtx.mode === "tui" && typeof commandCtx.ui.custom === "function") {
            const pickedIndex = await commandCtx.ui.custom<number>(
              (tui, theme, keybindings, done) => {
                let selectedIndex = 0;
                let expandedIndex: number | null = null;
                let scrollOffset = 0;

                const clampScrollOffset = (maxOffset: number) => {
                  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, maxOffset)));
                };

                return {
                  handleInput(data: string) {
                    if (keybindings.matches(data, "tui.select.up")) {
                      selectedIndex = Math.max(0, selectedIndex - 1);
                      tui.requestRender();
                      return;
                    }
                    if (keybindings.matches(data, "tui.select.down")) {
                      selectedIndex = Math.min(actionable.length - 1, selectedIndex + 1);
                      tui.requestRender();
                      return;
                    }

                    const right = keybindings.matches(data, "tui.select.right") || data === "\u001b[C";
                    const left = keybindings.matches(data, "tui.select.left") || data === "\u001b[D";
                    if (right) {
                      expandedIndex = selectedIndex;
                      tui.requestRender();
                      return;
                    }
                    if (left) {
                      expandedIndex = null;
                      tui.requestRender();
                      return;
                    }

                    if (keybindings.matches(data, "tui.select.confirm")) {
                      done(selectedIndex);
                      return;
                    }
                    if (keybindings.matches(data, "tui.select.cancel")) {
                      done(undefined);
                    }
                  },
                  render(width: number): string[] {
                    const outerWidth = Math.max(30, width);
                    const innerWidth = Math.max(10, outerWidth - 4);

                    const padPlain = (text: string, w: number): string => {
                      const t = truncatePlain(text, w);
                      return t + " ".repeat(Math.max(0, w - t.length));
                    };

                    const hintLines: Array<{ text: string; kind: "hint" | "normal" }> = [
                      {
                        text: "↑↓ select • → expand files • ← collapse • Enter confirm • Esc cancel",
                        kind: "hint",
                      },
                      { text: "", kind: "normal" },
                    ];
                    const entryLines: Array<{ text: string; kind: "normal" | "selected" | "file" }> = [];
                    let selectedLineIndex = 0;

                    for (let i = 0; i < actionable.length; i++) {
                      const isSelected = i === selectedIndex;
                      if (isSelected) selectedLineIndex = entryLines.length;
                      const rowText = `${isSelected ? "▶" : " "} ${actionable[i].label}`;
                      entryLines.push({ text: rowText, kind: isSelected ? "selected" : "normal" });

                      if (expandedIndex === i) {
                        for (const file of actionable[i].files) {
                          entryLines.push({ text: `    - ${file}`, kind: "file" });
                        }
                      }
                    }

                    const fixedChromeLines = 4;
                    const fixedBodyLines = hintLines.length;
                    const maxOverlayHeight = Math.max(10, Math.floor((tui.terminal?.rows ?? 24) * 0.85));
                    const visibleEntryLines = Math.max(4, maxOverlayHeight - fixedChromeLines - fixedBodyLines);
                    const maxOffset = Math.max(0, entryLines.length - visibleEntryLines);
                    const expandedLineCount =
                      expandedIndex === selectedIndex ? actionable[selectedIndex]?.files.length ?? 0 : 0;
                    const visibleRangeStart = selectedLineIndex;
                    const visibleRangeEnd = selectedLineIndex + expandedLineCount;
                    const visibleRangeLength = visibleRangeEnd - visibleRangeStart + 1;

                    if (visibleRangeLength <= visibleEntryLines) {
                      if (visibleRangeStart < scrollOffset) scrollOffset = visibleRangeStart;
                      if (visibleRangeEnd >= scrollOffset + visibleEntryLines) {
                        scrollOffset = visibleRangeEnd - visibleEntryLines + 1;
                      }
                    } else {
                      if (
                        visibleRangeStart < scrollOffset ||
                        visibleRangeStart >= scrollOffset + visibleEntryLines
                      ) {
                        scrollOffset = visibleRangeStart;
                      }
                    }
                    clampScrollOffset(maxOffset);

                    const viewport = entryLines.slice(scrollOffset, scrollOffset + visibleEntryLines);
                    const scrollInfo =
                      entryLines.length > visibleEntryLines
                        ? ` lines ${scrollOffset + 1}-${Math.min(entryLines.length, scrollOffset + visibleEntryLines)} / ${entryLines.length}`
                        : "";

                    const lines: string[] = [];
                    lines.push(theme.fg("accent", `┌${"─".repeat(Math.max(0, outerWidth - 2))}┐`));
                    const titleText = padPlain(`Restore files to checkpoint before:${scrollInfo}`, innerWidth);
                    lines.push(
                      theme.fg("accent", "│ ") +
                        theme.bold(titleText) +
                        theme.fg("accent", " │"),
                    );
                    lines.push(theme.fg("accent", `├${"─".repeat(Math.max(0, outerWidth - 2))}┤`));

                    for (const line of [...hintLines, ...viewport]) {
                      const padded = padPlain(line.text, innerWidth);
                      const styled =
                        line.kind === "selected"
                          ? theme.fg("accent", theme.bold(padded))
                          : line.kind === "hint" || line.kind === "file"
                            ? theme.fg("dim", padded)
                            : padded;
                      lines.push(theme.fg("accent", "│ ") + styled + theme.fg("accent", " │"));
                    }

                    lines.push(theme.fg("accent", `└${"─".repeat(Math.max(0, outerWidth - 2))}┘`));
                    return lines;
                  },
                };
              },
              { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "85%", margin: 1 } },
            );

            if (pickedIndex === undefined) return;
            targetEntry = actionable[pickedIndex]?.entry;
          } else {
            const picked = await commandCtx.ui.select(
              "Restore files to checkpoint before:",
              actionable.map((item) => item.label),
            );
            if (!picked) return;

            targetEntry = actionable.find((item) => item.label === picked)?.entry;
          }

          if (!targetEntry) return;
        }

        const targetSnapshot = getSnapshotByEntryId(targetEntry.id);
        if (!targetSnapshot) {
          commandCtx.ui.notify("Checkpoint snapshot missing.", "error");
          return;
        }

        const changeCount = await countSnapshotChanges(commandCtx, targetSnapshot, compareCache);
        const changedFiles =
          changeCount > 0 ? await listSnapshotChanges(commandCtx, targetSnapshot, compareCache) : [];

        if (commandCtx.mode === "tui") {
          const action = await chooseRestoreAction(commandCtx, targetEntry.id, changeCount);
          if (action === "cancel") return;

          if (action === "conversation" || action === "both") {
            programmaticTreeNavigationChoice = {
              targetId: targetEntry.id,
              restoreFiles: action === "both",
            };
            await commandCtx.navigateTree(targetEntry.id, { summarize: false });
            return;
          }

          if (changeCount === 0) {
            commandCtx.ui.notify("No file changes to restore for this checkpoint.", "info");
            return;
          }

          void changedFiles;
        }

        if (changeCount === 0) {
          commandCtx.ui.notify("No file changes to restore for this checkpoint.", "info");
          return;
        }

        const changed = await restoreSnapshot(commandCtx, targetSnapshot);
        commandCtx.ui.notify(
          `Restored ${changed} file${changed === 1 ? "" : "s"} from checkpoint ${shortId(targetEntry.id)}.`,
          "success",
        );
      });
    },
  });
}
