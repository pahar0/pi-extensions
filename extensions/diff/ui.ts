import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, Editor, Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { collectSnapshot, loadFileDiff, prepareReview } from "./git.ts";
import {
  annotationLabel, makeAnnotation, MAX_NOTE_LENGTH, MAX_NOTES,
  type Annotation, type DiffRow, type FileDiff, type Snapshot,
} from "./model.ts";

export interface ReviewScreenOptions {
  snapshot: Snapshot;
  annotations: Annotation[];
  onChange: (annotations: Annotation[]) => void;
  onDone: (prompt: string | undefined) => void;
  loadFile?: typeof loadFileDiff;
  collect?: typeof collectSnapshot;
  prepare?: typeof prepareReview;
}

type Mode = "diff" | "notes" | "editor";
type DisplayRow = { index: number } | { text: string; noteId?: string };
type SourceRow = Extract<DiffRow, { kind: "line" }>;

/** Escape source controls rather than allowing repository text to emit terminal commands. */
export function safeText(text: string): string {
  return text.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "", true);
}

function sourcePrefix(row: SourceRow, marker = " "): string {
  const oldNumber = row.old ? String(row.old.line).padStart(5) : "     ";
  const newNumber = row.new ? String(row.new.line).padStart(5) : "     ";
  const sign = row.changed ? row.old ? "-" : "+" : " ";
  return `${marker}${oldNumber} ${newNumber} ${sign} `;
}

const FILE_STATUS_COLORS: Readonly<Record<string, ThemeColor>> = {
  A: "toolDiffAdded",
  D: "toolDiffRemoved",
  M: "warning",
  T: "warning",
  R: "accent",
  C: "accent",
  U: "error",
  "?": "muted",
  "!": "muted",
};

export class DiffReviewScreen implements Component, Focusable {
  private snapshot: Snapshot;
  private annotations: Annotation[];
  private mode: Mode = "diff";
  private editorReturn: Mode = "diff";
  private focus: "files" | "diff" = "diff";
  private hasFocus = false;
  private fileIndex = 0;
  private cursor = 0;
  private rangeStart: number | undefined;
  private scroll = 0;
  private horizontal = 0;
  private lastMainWidth = 0;
  private horizontalBounds?: { file: FileDiff; width: number; max: number };
  private sidebar = true;
  private file?: FileDiff;
  private loading = false;
  private busy = false;
  private finished = false;
  private loadGeneration = 0;
  private status = "";
  private noteIndex = 0;
  private listScroll = 0;
  private notesManualScroll = false;
  private deletePending?: string;
  private draft?: Annotation;
  private editor: Editor;
  private cache = new Map<string, FileDiff>();
  private displayCache?: { file: FileDiff; width: number; rows: DisplayRow[] };
  private abort = new AbortController();
  private fileAbort?: AbortController;
  private bodyHeight = 15;
  private lastSidebarWidth = 0;
  private lastDisplayRows: DisplayRow[] = [];
  readonly ready: Promise<void>;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private options: ReviewScreenOptions;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, options: ReviewScreenOptions) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.options = options;
    this.snapshot = options.snapshot;
    this.annotations = options.annotations.map((note) => ({ ...note }));
    this.editor = new Editor(tui, {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    }, { paddingX: 1 });
    this.editor.onSubmit = (value) => this.saveComment(value);
    this.ready = this.selectFile(0);
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && this.mode === "editor";
  }

  invalidate(): void {
    this.displayCache = undefined;
    this.horizontalBounds = undefined;
    this.editor.invalidate();
  }

  dispose(): void {
    this.finished = true;
    this.abort.abort();
    this.fileAbort?.abort();
    this.editor.focused = false;
  }

  private renderSoon(): void {
    if (!this.finished) this.tui.requestRender();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.deletePending = undefined;
    this.editor.focused = this.hasFocus && mode === "editor";
    this.listScroll = 0;
    this.notesManualScroll = false;
    this.renderSoon();
  }

  private finish(prompt?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.options.onDone(prompt);
  }

  private persist(): void {
    this.displayCache = undefined;
    this.options.onChange(this.annotations.map((note) => ({ ...note })));
  }

  private async selectFile(index: number): Promise<void> {
    const generation = ++this.loadGeneration;
    this.fileAbort?.abort();
    const fileAbort = this.fileAbort = new AbortController();
    this.fileIndex = Math.max(0, Math.min(this.snapshot.files.length - 1, index));
    this.cursor = this.scroll = this.horizontal = 0;
    this.rangeStart = undefined;
    this.file = undefined;
    this.displayCache = undefined;
    const changed = this.snapshot.files[this.fileIndex];
    if (!changed) { this.loading = false; this.renderSoon(); return; }
    this.loading = true;
    this.status = "";
    this.renderSoon();
    try {
      const file = this.cache.get(changed.path) ?? await (this.options.loadFile ?? loadFileDiff)(this.snapshot, changed.path, fileAbort.signal);
      if (this.finished || generation !== this.loadGeneration) return;
      this.file = file;
      this.cache.delete(changed.path);
      this.cache.set(changed.path, file);
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      this.cursor = Math.max(0, file.rows.findIndex((row) => row.kind === "line"));
    } catch (error) {
      if (!this.finished && generation === this.loadGeneration) this.status = `Cannot load diff: ${(error as Error).message}`;
    } finally {
      if (generation === this.loadGeneration) this.loading = false;
      this.renderSoon();
    }
  }

  private selectedSide(): "old" | "new" | "both" {
    const start = this.rangeStart ?? this.cursor;
    let removed = false;
    let added = false;
    for (let index = Math.min(start, this.cursor); index <= Math.max(start, this.cursor); index++) {
      const row = this.file?.rows[index];
      if (row?.kind !== "line") continue;
      if (row.old && !row.new) removed = true;
      if (row.new && !row.old) added = true;
    }
    return removed && added ? "both" : removed ? "old" : "new";
  }

  private toggleRange(): void {
    if (this.rangeStart !== undefined) {
      this.rangeStart = undefined;
      this.status = "Range cleared.";
    } else if (this.file?.rows[this.cursor]?.kind === "line") {
      this.rangeStart = this.cursor;
      this.focus = "diff";
      this.status = "Move to the end of the range, then press c. Removed and added lines can be selected together.";
    } else this.status = "Choose a source line first.";
  }

  private beginComment(scope: Annotation["scope"]): void {
    try {
      if (this.annotations.length >= MAX_NOTES) throw new Error(`At most ${MAX_NOTES} notes per review. Submit or delete some first.`);
      const side = this.selectedSide();
      if (scope === "line" || scope === "range") {
        const first = this.file?.rows[this.rangeStart ?? this.cursor];
        const last = this.file?.rows[this.cursor];
        if (first?.kind !== "line" || last?.kind !== "line") throw new Error("Choose source lines to annotate.");
        this.focus = "diff";
      }
      this.draft = makeAnnotation(this.snapshot, scope, this.file, side, this.rangeStart ?? this.cursor, this.cursor);
      this.editorReturn = "diff";
      this.editor.setText("");
      this.status = "";
      this.setMode("editor");
    } catch (error) { this.status = (error as Error).message; }
    this.renderSoon();
  }

  private editComment(): void {
    const note = this.annotations[this.noteIndex];
    if (!note) return;
    this.draft = { ...note };
    this.editorReturn = "notes";
    this.editor.setText(note.text);
    this.setMode("editor");
  }

  private saveComment(submittedText?: string): void {
    if (!this.draft) return;
    const text = (submittedText ?? this.editor.getExpandedText()).trim();
    if (!text) { this.status = "Comment is empty. Type a note, or Escape to cancel."; this.renderSoon(); return; }
    if (text.length > MAX_NOTE_LENGTH) {
      if (submittedText !== undefined) this.editor.setText(submittedText);
      this.status = `Comment exceeds ${MAX_NOTE_LENGTH.toLocaleString()} characters.`;
      this.renderSoon();
      return;
    }
    const note = { ...this.draft, text };
    const index = this.annotations.findIndex((candidate) => candidate.id === note.id);
    if (index >= 0) this.annotations[index] = note;
    else this.annotations.push(note);
    this.noteIndex = index >= 0 ? index : this.annotations.length - 1;
    this.persist();
    this.draft = undefined;
    this.rangeStart = undefined;
    this.status = "Comment saved to this session branch.";
    this.setMode(this.editorReturn);
  }

  private async refresh(): Promise<void> {
    this.busy = true;
    this.status = "Refreshing…";
    this.renderSoon();
    try {
      const path = this.file?.path;
      this.snapshot = await (this.options.collect ?? collectSnapshot)(this.snapshot.target, this.abort.signal);
      if (this.finished) return;
      this.cache.clear();
      await this.selectFile(Math.max(0, this.snapshot.files.findIndex((file) => file.path === path)));
      this.status = "Refreshed. Existing notes keep their original anchors; submission checks for stale locations.";
    } catch (error) { if (!this.finished) this.status = (error as Error).message; }
    finally { this.busy = false; this.renderSoon(); }
  }

  private async submit(): Promise<void> {
    if (!this.annotations.length) { this.status = "Add a comment with c, a file note with f, or a diff note with n first."; this.renderSoon(); return; }
    this.busy = true;
    this.status = "Checking the current files and annotation anchors…";
    this.renderSoon();
    try {
      const prepared = await (this.options.prepare ?? prepareReview)(this.snapshot, this.annotations, this.abort.signal);
      if (this.finished) return;
      this.finish(prepared.prompt);
    } catch (error) { if (!this.finished) this.status = (error as Error).message; }
    finally { this.busy = false; this.renderSoon(); }
  }

  private openNotes(): void {
    this.noteIndex = Math.max(0, Math.min(this.annotations.length - 1, this.noteIndex));
    this.deletePending = undefined;
    this.setMode("notes");
  }

  private move(delta: number): void {
    if (this.mode === "diff") {
      if (this.focus === "files") void this.selectFile(this.fileIndex + delta);
      else {
        const rows = this.file?.rows ?? [];
        const direction = Math.sign(delta);
        let remaining = Math.abs(delta);
        for (let i = this.cursor + direction; remaining > 0 && i >= 0 && i < rows.length; i += direction) {
          if (rows[i].kind !== "line") continue;
          this.cursor = i;
          remaining--;
        }
      }
    } else if (this.mode === "notes") {
      this.noteIndex = Math.max(0, Math.min(this.annotations.length - 1, this.noteIndex + delta));
      this.deletePending = undefined;
      this.notesManualScroll = false;
    } else this.listScroll = Math.max(0, this.listScroll + delta);
    this.renderSoon();
  }

  private scrollHorizontal(delta: number): void {
    const file = this.file;
    const width = this.lastMainWidth;
    if (!file || width <= 0) { this.horizontal = 0; return; }
    if (this.horizontalBounds?.file !== file || this.horizontalBounds.width !== width) {
      let max = 0;
      for (const row of file.rows) {
        if (row.kind !== "line") continue;
        const cell = row.new ?? row.old;
        const available = Math.max(0, width - visibleWidth(sourcePrefix(row)));
        if (cell && available > 0) max = Math.max(max, visibleWidth(safeText(cell.text)) - available);
      }
      this.horizontalBounds = { file, width, max };
    }
    this.horizontal = Math.max(0, Math.min(this.horizontalBounds.max, this.horizontal + delta));
  }

  private jumpHunk(direction: number): void {
    const rows = this.file?.rows ?? [];
    const targets = rows.flatMap((row, i) => row.kind === "hunk" ? [Math.min(rows.length - 1, i + 1)] : []);
    const target = direction > 0 ? targets.find((index) => index > this.cursor)
      : targets.filter((index) => index < this.cursor).at(-1);
    if (target !== undefined) this.cursor = target;
    this.renderSoon();
  }

  handleInput(data: string): void {
    if (this.finished) return;
    const cancel = this.keybindings.matches(data, "tui.select.cancel");
    if (this.busy) { if (cancel) this.finish(); return; }
    if (this.mode === "editor") {
      if (cancel) { this.draft = undefined; this.status = "Comment editing cancelled."; this.setMode(this.editorReturn); }
      else if (matchesKey(data, Key.ctrl("s"))) this.saveComment();
      else this.editor.handleInput(data);
      this.renderSoon();
      return;
    }
    if (cancel || data === "q") {
      if (this.mode !== "diff") { this.status = ""; this.setMode("diff"); }
      else this.finish();
      return;
    }
    if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.ctrl("enter"))) {
      void this.submit();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") { this.move(-1); return; }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") { this.move(1); return; }
    if (this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown")) {
      const delta = this.keybindings.matches(data, "tui.select.pageUp") ? -this.bodyHeight : this.bodyHeight;
      if (this.mode === "notes") {
        this.notesManualScroll = true;
        this.listScroll = Math.max(0, this.listScroll + delta);
        this.renderSoon();
      } else this.move(delta);
      return;
    }
    if (matchesKey(data, Key.home)) { this.move(-1_000_000); return; }
    if (matchesKey(data, Key.end)) { this.move(1_000_000); return; }
    if (this.mode === "notes") {
      if (this.keybindings.matches(data, "tui.select.confirm") || data === "e") this.editComment();
      else if (data === "n") this.beginComment("review");
      else if (data === "d" && this.annotations[this.noteIndex]) {
        const id = this.annotations[this.noteIndex].id;
        if (this.deletePending === id) {
          this.annotations.splice(this.noteIndex, 1);
          this.noteIndex = Math.max(0, Math.min(this.noteIndex, this.annotations.length - 1));
          this.persist();
          this.deletePending = undefined;
          this.status = "Note deleted.";
        } else { this.deletePending = id; this.status = "Press d again to delete this note; move or Escape to cancel."; }
      }
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.focus = this.lastSidebarWidth > 0 && this.focus === "diff" ? "files" : "diff";
      this.rangeStart = undefined;
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.scrollHorizontal(matchesKey(data, Key.left) ? -12 : 12);
      this.focus = "diff";
    } else if (this.keybindings.matches(data, "tui.select.confirm") && this.focus === "files") this.focus = "diff";
    else if (data === "c") this.beginComment(this.rangeStart === undefined ? "line" : "range");
    else if (data === "f") this.beginComment("file");
    else if (data === "n") this.beginComment("review");
    else if (data === "v") this.toggleRange();
    else if (data === "a" || data === "e") this.openNotes();
    else if (data === "b") { this.sidebar = !this.sidebar; if (!this.sidebar && this.focus === "files") this.focus = "diff"; }
    else if (data === "[") this.jumpHunk(-1);
    else if (data === "]") this.jumpHunk(1);
    else if (data === "{") this.scrollHorizontal(-12);
    else if (data === "}") this.scrollHorizontal(12);
    else if (data === "r") void this.refresh();
    this.renderSoon();
  }

  private displayRows(width: number): DisplayRow[] {
    const file = this.file;
    if (!file) return [];
    if (this.displayCache?.file === file && this.displayCache.width === width) return this.displayCache.rows;
    const result: DisplayRow[] = [];
    const notes = this.annotations.filter((note) => note.path === file.path);
    const anchored = new Map<string, Annotation[]>();
    const used = new Set<string>();
    const addNote = (note: Annotation) => {
      const stale = note.fingerprint !== file.fingerprint || note.base !== this.snapshot.base;
      const label = ` 💬 ${stale ? "[stale anchor] " : ""}${note.scope === "file" ? "File: " : ""}${note.text}`;
      for (const line of label.split("\n")) {
        for (const text of wrapTextWithAnsi(safeText(line), Math.max(1, width - 2))) result.push({ text, noteId: note.id });
      }
      used.add(note.id);
    };
    for (const note of notes) {
      if (note.scope === "file") addNote(note);
      else {
        const side = note.side === "both" ? note.anchorSide : note.side;
        const endLine = note.side === "both" ? (side === "old" ? note.oldRange : note.newRange)?.endLine : note.endLine;
        const key = `${side}:${endLine}`;
        anchored.set(key, [...(anchored.get(key) ?? []), note]);
      }
    }
    if (file.message) {
      for (const line of file.message.split("\n")) for (const text of wrapTextWithAnsi(safeText(line), Math.max(1, width))) result.push({ text });
    }
    file.rows.forEach((row, index) => {
      if (row.kind !== "line") return;
      result.push({ index });
      for (const side of ["old", "new"] as const) {
        for (const note of anchored.get(`${side}:${row[side]?.line}`) ?? []) if (!used.has(note.id)) addNote(note);
      }
    });
    for (const note of notes) if (!used.has(note.id)) addNote(note);
    this.displayCache = { file, width, rows: result };
    return result;
  }

  private sourceLine(row: SourceRow, index: number, width: number): string {
    const cell = row.new ?? row.old;
    if (!cell) return fit("", width);
    const selected = index === this.cursor && this.focus === "diff";
    const range = this.rangeStart !== undefined && this.focus === "diff" &&
      index >= Math.min(this.rangeStart, this.cursor) && index <= Math.max(this.rangeStart, this.cursor);
    const prefix = sourcePrefix(row, selected ? "›" : range ? "│" : " ");
    const remaining = Math.max(0, width - visibleWidth(prefix));
    const text = prefix + sliceByColumn(safeText(cell.text), this.horizontal, remaining);
    const colored = this.theme.fg(row.changed ? row.old ? "toolDiffRemoved" : "toolDiffAdded" : "toolDiffContext", fit(text, width));
    return selected || range ? this.theme.bg("selectedBg", colored) : colored;
  }

  private renderDiff(width: number): string[] {
    const sidebarWidth = this.sidebar && width >= 100 ? Math.min(30, Math.floor(width * 0.23)) : 0;
    this.lastSidebarWidth = sidebarWidth;
    if (!sidebarWidth && this.focus === "files") this.focus = "diff";
    const mainWidth = this.lastMainWidth = width - (sidebarWidth ? sidebarWidth + 1 : 0);
    this.scrollHorizontal(0);
    const rows = this.displayRows(mainWidth);
    const selectedDisplay = rows.findIndex((row) => "index" in row && row.index === this.cursor);
    if (selectedDisplay >= 0) {
      if (selectedDisplay < this.scroll) this.scroll = selectedDisplay;
      if (selectedDisplay >= this.scroll + this.bodyHeight) this.scroll = selectedDisplay - this.bodyHeight + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, rows.length - this.bodyHeight));
    this.lastDisplayRows = rows.slice(this.scroll, this.scroll + this.bodyHeight);
    const fileStart = Math.max(0, this.fileIndex - this.bodyHeight + 1);
    const result: string[] = [];
    for (let y = 0; y < this.bodyHeight; y++) {
      let main = "";
      if (this.loading && y === 0) main = this.theme.fg("muted", "Loading diff…");
      else if (!this.snapshot.files.length && y === 0) main = "No changes for this path. n adds a general note; a opens saved notes.";
      else {
        const item = this.lastDisplayRows[y];
        if (item && "index" in item) {
          const row = this.file!.rows[item.index];
          if (row.kind === "line") main = this.sourceLine(row, item.index, mainWidth);
        } else if (item) main = this.theme.fg(item.noteId ? "warning" : "muted", fit(item.text, mainWidth));
      }
      let side = "";
      if (sidebarWidth) {
        const file = this.snapshot.files[fileStart + y];
        if (file) {
          const count = this.annotations.filter((note) => note.path === file.path).length;
          const selected = fileStart + y === this.fileIndex;
          const marker = this.focus === "files" && selected ? "›" : " ";
          const status = this.theme.fg(FILE_STATUS_COLORS[file.status.charAt(0)] ?? "muted", safeText(file.status));
          const label = `${safeText(file.path)}${count ? ` ●${count}` : ""}`;
          side = fit(`${selected ? this.theme.fg("accent", marker) : marker}${status} ${selected ? this.theme.fg("accent", label) : label}`, sidebarWidth);
          if (selected) side = this.theme.bg("selectedBg", side);
        }
        side = fit(side, sidebarWidth) + this.theme.fg("borderMuted", "│");
      }
      result.push(side + fit(main, mainWidth));
    }
    return result;
  }

  private renderNotes(width: number): string[] {
    const rows: { text: string; index: number }[] = [];
    this.annotations.forEach((note, index) => {
      for (const line of [`${index === this.noteIndex ? "›" : " "} ${index + 1}. ${annotationLabel(note)}`, ...note.text.split("\n").map((line) => `    ${line}`), ""]) {
        for (const text of wrapTextWithAnsi(safeText(line), width)) rows.push({ text, index });
      }
    });
    const selected = rows.findIndex((row) => row.index === this.noteIndex);
    if (!this.notesManualScroll && selected >= 0 && (selected < this.listScroll || selected >= this.listScroll + this.bodyHeight)) this.listScroll = selected;
    this.listScroll = Math.max(0, Math.min(this.listScroll, rows.length - this.bodyHeight));
    const body = rows.slice(this.listScroll, this.listScroll + this.bodyHeight).map((row) => row.index === this.noteIndex
      ? this.theme.bg("selectedBg", fit(row.text, width)) : row.text);
    if (!rows.length) body.push("No saved notes yet. Escape to return; c comments on a line, n adds a diff note.");
    return [this.theme.fg("accent", "Saved notes · Enter/e edit · d,d delete · Escape back"), ...body];
  }

  private renderEditor(width: number): string[] {
    const heading = this.theme.fg("accent", safeText(annotationLabel(this.draft!)));
    const excerpt = this.draft?.excerpt?.split("\n") ?? [];
    let preview = excerpt.slice(0, 1);
    if (this.draft?.scope === "range" && excerpt.length) {
      if (this.draft.side === "both") {
        preview = [excerpt[0], ...(excerpt.length > 2 ? ["…"] : []), ...(excerpt.length > 1 ? [excerpt.at(-1)!] : [])];
      } else {
        const endLine = this.draft.endLine!;
        const last = excerpt.filter((line) => line.startsWith(`${endLine}: `)).at(-1)
          ?? `${endLine}: [not captured in saved excerpt]`;
        preview = [excerpt[0], ...(endLine > this.draft.startLine! + 1 ? ["…"] : []), last];
      }
    }
    const context = preview.map((line) => this.theme.fg("muted", fit(safeText(line), width)));
    const editorLines = this.editor.render(width);
    const maxContext = Math.max(0, this.bodyHeight - editorLines.length);
    const body = [...context.slice(0, maxContext), ...editorLines];
    // On very short terminals, center the retained editor rows on its cursor.
    const cursorRow = body.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = body.length <= this.bodyHeight ? 0 : Math.max(0,
      Math.min(body.length - this.bodyHeight, cursorRow < 0 ? body.length : cursorRow - Math.floor(this.bodyHeight / 2)));
    return [heading, ...body.slice(start, start + this.bodyHeight)];
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (width < 24 || height < 8) return Array.from({ length: height }, (_, i) => fit(i === 0 ? "Enlarge terminal (24×8)." : i === 1 ? "Esc closes; drafts saved." : "", width));
    const contentHeight = height - 4;
    this.bodyHeight = contentHeight - (this.mode === "diff" ? 0 : 1);
    const file = this.snapshot.files[this.fileIndex];
    const title = this.theme.fg("accent", ` /diff · ${this.annotations.length} note(s) · ${this.snapshot.files.length} file(s)`);
    const subtitle = this.theme.fg("muted", ` ${safeText(this.snapshot.target)}${file ? ` · ${safeText(file.path)}` : ""}${this.file ? `  +${this.file.added} −${this.file.removed}` : ""}`);
    let content: string[];
    if (this.mode === "diff") content = this.renderDiff(width);
    else if (this.mode === "notes") content = this.renderNotes(width);
    else content = this.renderEditor(width);
    while (content.length < contentHeight) content.push("");
    const footer = this.mode === "editor" ? " Enter/Ctrl+S save · Shift+Enter newline · Esc cancel" :
      this.mode === "diff" ? " Tab focus · c comment · v range · f file note · n diff note · a notes · Ctrl+S send · Esc close" :
        " ↑↓ navigate · Esc back · Ctrl+S send to Pi";
    const status = this.status || (this.rangeStart !== undefined && this.mode === "diff" ? "Range selection active · move, then c to comment" : "Drafts saved in this session branch · Ctrl+S outside the editor sends to Pi.");
    return [title, subtitle, ...content.slice(0, contentHeight), this.theme.fg("muted", safeText(status)), this.theme.fg("dim", footer)]
      .slice(0, height).map((line) => fit(line, width));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.finished || this.busy || this.mode === "editor") return undefined;
    if (event.type === "wheel") {
      this.move((event.wheelDelta ?? 0) * (event.alt ? 5 : 1));
      return { handled: true, render: true };
    }
    if (event.type !== "press" || event.button !== "left" || this.mode !== "diff") return undefined;
    const y = event.y - 2;
    if (y < 0 || y >= this.bodyHeight) return { handled: true };
    if (this.lastSidebarWidth && event.x < this.lastSidebarWidth) {
      const start = Math.max(0, this.fileIndex - this.bodyHeight + 1);
      if (this.snapshot.files[start + y]) { this.focus = "files"; void this.selectFile(start + y); }
    } else {
      const item = this.lastDisplayRows[y];
      if (item && "index" in item) {
        this.rangeStart = event.shift && this.focus === "diff" ? this.rangeStart ?? this.cursor : undefined;
        this.focus = "diff";
        this.cursor = item.index;
      } else if (item?.noteId) {
        this.noteIndex = this.annotations.findIndex((note) => note.id === item.noteId);
        this.openNotes();
      }
    }
    return { handled: true, focus: true, render: true };
  }
}
