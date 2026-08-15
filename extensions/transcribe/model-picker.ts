import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CATALOG_MODELS,
  catalogModelSearchText,
  canonicalLanguage,
  displayLanguage,
  formatBinarySize,
  getCatalogLanguages,
  rankCatalogModels,
  type CatalogModel,
} from "./catalog.js";
import { findCachedCatalogModel, type CachedCatalogModel } from "./models.js";
import type { TranscriptionLanguage } from "./settings.js";

type UiTheme = ExtensionContext["ui"]["theme"];

const MAX_VISIBLE_LANGUAGES = 9;
const MAX_VISIBLE_MODELS = 10;
const MODEL_NAME_WIDTH = 34;
const MODEL_DETAIL_WIDTH = 18;
const TRANSCRIPTION_LANGUAGE_NAME_WIDTH = 28;

function padColumn(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function transcriptionLanguageName(
  language: string,
  supportedLanguages: readonly string[],
): string {
  const base = canonicalLanguage(language);
  const variants = supportedLanguages.filter(
    (supported) => canonicalLanguage(supported) === base,
  );
  return displayLanguage(variants.length > 1 ? language : base);
}

function selectedWindow<T>(items: readonly T[], selected: number, maximum: number): [number, number] {
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maximum / 2), items.length - maximum),
  );
  return [start, Math.min(start + maximum, items.length)];
}

class LanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", 1, 0);
  private readonly selected: Set<string>;
  private filtered: string[];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    initial: readonly string[],
    private readonly done: (languages: string[] | undefined) => void,
  ) {
    super();
    const available = getCatalogLanguages();
    this.filtered = available;
    this.selected = new Set(
      initial.map(canonicalLanguage).filter((language) => available.includes(language)),
    );

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Preferred languages")), 1, 0));
    this.addChild(
      new Text(
        theme.fg("muted", "Used to rank models. It does not prevent choosing any model."),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.refresh();
  }

  private selectedLanguages(): string[] {
    return getCatalogLanguages().filter((language) => this.selected.has(language));
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    const all = getCatalogLanguages();
    this.filtered = query
      ? fuzzyFilter(all, query, (language) => `${displayLanguage(language)} ${language}`)
      : all;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), 0, 0));
    } else {
      const [start, end] = selectedWindow(this.filtered, this.selectedIndex, MAX_VISIBLE_LANGUAGES);
      for (let index = start; index < end; index += 1) {
        const language = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const checked = this.selected.has(language);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const mark = checked ? this.theme.fg("success", "✓") : this.theme.fg("dim", "□");
        const label = `${displayLanguage(language)} ${this.theme.fg("dim", `[${language}]`)}`;
        this.list.addChild(
          new Text(`${prefix}${mark} ${active ? this.theme.fg("accent", label) : label}`, 0, 0),
        );
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0),
        );
      }
    }

    const selected = this.selectedLanguages();
    const count = selected.length === 1 ? "1 selected" : `${selected.length} selected`;
    const instructions = `${rawKeyHint("space", "toggle")}  ${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "cancel")}`;
    this.footer.setText(
      `${this.theme.fg(selected.length > 0 ? "muted" : "warning", count)}\n${instructions}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.space)) {
      const language = this.filtered[this.selectedIndex];
      if (language) {
        if (this.selected.has(language)) this.selected.delete(language);
        else this.selected.add(language);
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.selectedLanguages();
      if (selected.length > 0) this.done(selected);
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) && this.search.getValue()) {
      this.search.setValue("");
      this.selectedIndex = 0;
      this.refresh();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

type CatalogModelPickerResult =
  | { type: "model"; model: CatalogModel }
  | { type: "change-languages" };

class CatalogModelPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly detail = new Text("", 1, 0);
  private readonly footer = new Text("", 1, 0);
  private readonly cachedById = new Map<string, CachedCatalogModel>();
  private readonly models: CatalogModel[];
  private filtered: CatalogModel[] = [];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    private readonly preferredLanguages: readonly string[],
    currentModelId: string | undefined,
    private readonly done: (result: CatalogModelPickerResult | undefined) => void,
  ) {
    super();
    for (const model of CATALOG_MODELS) {
      const cached = findCachedCatalogModel(model);
      if (cached) this.cachedById.set(model.id, cached);
    }
    this.models = rankCatalogModels(
      CATALOG_MODELS,
      preferredLanguages,
      (model) => this.cachedById.has(model.id),
    );
    const currentIndex = this.models.findIndex((model) => model.id === currentModelId);
    if (currentIndex > 0) {
      const [current] = this.models.splice(currentIndex, 1);
      if (current) this.models.unshift(current);
    }

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("accent", theme.bold("Choose a transcription model")), 1, 0));
    this.addChild(
      new Text(
        `${theme.fg("muted", `Preferred: ${preferredLanguages.map(displayLanguage).join(", ")}`)} · ${keyHint("tui.input.tab", "change")}`,
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.detail);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.models, query, catalogModelSearchText)
      : this.models;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
      this.detail.setText("");
    } else {
      const [start, end] = selectedWindow(this.filtered, this.selectedIndex, MAX_VISIBLE_MODELS);
      for (let index = start; index < end; index += 1) {
        const model = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const cached = this.cachedById.get(model.id);
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const nameText = model.name.padEnd(MODEL_NAME_WIDTH);
        const name = active ? this.theme.fg("accent", nameText) : nameText;
        const detailText = `${model.quant} · ${formatBinarySize(model.size)}`.padEnd(
          MODEL_DETAIL_WIDTH,
        );
        const detail = this.theme.fg("dim", detailText);
        const downloaded = cached ? `  ${this.theme.fg("success", "downloaded")}` : "";
        const recommended = model.recommended
          ? `  ${this.theme.fg("accent", "recommended")}`
          : "";
        this.list.addChild(
          new Text(`${prefix}${name}  ${detail}${downloaded}${recommended}`, 0, 0),
        );
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(
            this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`),
            0,
            0,
          ),
        );
      }

      const selected = this.filtered[this.selectedIndex]!;
      const languageCount = new Set(selected.languages.map(canonicalLanguage)).size;
      const features = [
        selected.capabilities.languageDetection ? "auto language detection" : undefined,
        `${languageCount} language${languageCount === 1 ? "" : "s"}`,
        selected.parameters ?? undefined,
      ].filter((value): value is string => Boolean(value));
      this.detail.setText(
        `${this.theme.fg("muted", selected.description)}\n${this.theme.fg("dim", features.join(" · "))}`,
      );
    }

    const shown = query
      ? `${this.filtered.length}/${this.models.length} matching models`
      : `${this.models.length} models`;
    this.footer.setText(
      `${this.theme.fg("dim", shown)}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "choose")}  ${keyHint("tui.select.cancel", query ? "clear search" : "cancel")}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.done({ type: "change-languages" });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done({ type: "model", model: selected });
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

export function defaultSpokenLanguages(): string[] {
  const locale = canonicalLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  return getCatalogLanguages().includes(locale) ? [locale] : ["en"];
}

export async function chooseLanguages(
  ctx: ExtensionContext,
  initial: readonly string[] = defaultSpokenLanguages(),
): Promise<string[] | undefined> {
  return ctx.ui.custom<string[] | undefined>((tui, theme, keybindings, done) =>
    new LanguagePicker(
      tui,
      theme,
      keybindings,
      initial,
      done,
    ),
  );
}

export async function chooseCatalogModel(
  ctx: ExtensionContext,
  preferredLanguages: readonly string[],
  currentModelId?: string,
): Promise<CatalogModelPickerResult | undefined> {
  return ctx.ui.custom<CatalogModelPickerResult | undefined>(
    (tui, theme, keybindings, done) =>
      new CatalogModelPicker(
        tui,
        theme,
        keybindings,
        preferredLanguages,
        currentModelId,
        done,
      ),
  );
}

type TranscriptionLanguageChoice = {
  value: TranscriptionLanguage;
  name: string;
  preferred: boolean;
};

class TranscriptionLanguagePicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly list = new Container();
  private readonly footer = new Text("", 1, 0);
  private readonly choices: TranscriptionLanguageChoice[];
  private filtered: TranscriptionLanguageChoice[] = [];
  private selectedIndex = 0;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: UiTheme,
    private readonly keybindings: KeybindingsManager,
    model: CatalogModel,
    current: TranscriptionLanguage,
    preferredLanguages: readonly string[],
    private readonly done: (language: TranscriptionLanguage | undefined) => void,
  ) {
    super();
    const preferred = new Set(preferredLanguages.map(canonicalLanguage));
    const languages = [...new Set(model.languages)]
      .map((language) => ({
        value: language,
        name: transcriptionLanguageName(language, model.languages),
        preferred: preferred.has(canonicalLanguage(language)),
      }))
      .sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) ||
          left.name.localeCompare(right.name) ||
          left.value.localeCompare(right.value),
      );
    this.choices = [
      ...(model.capabilities.languageDetection
        ? [{ value: "auto", name: "Auto detect", preferred: false }]
        : []),
      ...languages,
    ];
    this.filtered = this.choices;
    this.selectedIndex = Math.max(
      0,
      this.choices.findIndex((choice) => choice.value === current),
    );

    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(theme.fg("accent", theme.bold("Choose transcription language")), 1, 0),
    );
    this.addChild(
      new Text(
        theme.fg("muted", "★ Your languages are shown first. Type to search."),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.footer);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.refresh();
  }

  private refresh(): void {
    const query = this.search.getValue().trim();
    this.filtered = query
      ? fuzzyFilter(this.choices, query, (choice) => `${choice.name} ${choice.value}`)
      : this.choices;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
    this.list.clear();

    if (this.filtered.length === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  No matching languages"), 0, 0));
    } else {
      const [start, end] = selectedWindow(
        this.filtered,
        this.selectedIndex,
        MAX_VISIBLE_LANGUAGES,
      );
      for (let index = start; index < end; index += 1) {
        const choice = this.filtered[index]!;
        const active = index === this.selectedIndex;
        const prefix = active ? this.theme.fg("accent", "→ ") : "  ";
        const nameText = padColumn(choice.name, TRANSCRIPTION_LANGUAGE_NAME_WIDTH);
        const name = active ? this.theme.fg("accent", nameText) : nameText;
        const code = choice.value === "auto" ? "" : this.theme.fg("dim", choice.value);
        const yours = choice.preferred ? `  ${this.theme.fg("accent", "★")}` : "";
        this.list.addChild(new Text(`${prefix}${name}  ${code}${yours}`, 0, 0));
      }
      if (start > 0 || end < this.filtered.length) {
        this.list.addChild(
          new Text(
            this.theme.fg(
              "muted",
              `  (${this.selectedIndex + 1}/${this.filtered.length})`,
            ),
            0,
            0,
          ),
        );
      }
    }

    const shown = query
      ? `${this.filtered.length}/${this.choices.length} matching languages`
      : `${this.choices.length} choices`;
    this.footer.setText(
      `${this.theme.fg("dim", shown)}\n${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "choose")}  ${keyHint("tui.select.cancel", query ? "clear search" : "cancel")}`,
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.filtered.length > 0) {
        this.selectedIndex =
          this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
        this.refresh();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.done(selected.value);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.search.getValue()) {
        this.search.setValue("");
        this.selectedIndex = 0;
        this.refresh();
      } else {
        this.done(undefined);
      }
      return;
    }

    this.search.handleInput(data);
    this.selectedIndex = 0;
    this.refresh();
  }
}

export function transcriptionLanguageSummary(
  language: TranscriptionLanguage,
  model: CatalogModel,
): string {
  return language === "auto"
    ? "Auto detect"
    : transcriptionLanguageName(language, model.languages);
}

export async function chooseTranscriptionLanguage(
  ctx: ExtensionContext,
  model: CatalogModel,
  current: TranscriptionLanguage,
  preferredLanguages: readonly string[],
): Promise<TranscriptionLanguage | undefined> {
  return ctx.ui.custom<TranscriptionLanguage | undefined>(
    (tui, theme, keybindings, done) =>
      new TranscriptionLanguagePicker(
        tui,
        theme,
        keybindings,
        model,
        current,
        preferredLanguages,
        done,
      ),
  );
}
