import {
  DynamicBorder,
  keyHint,
  rawKeyHint,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  parseKey,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";

export const DEFAULT_SHORTCUT = "ctrl+alt+z";

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const SPECIAL_KEYS = new Set([
  "escape",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/"]);

export function normalizeShortcut(input: string): string | undefined {
  const parts = input
    .trim()
    .toLowerCase()
    .replaceAll("option", "alt")
    .replaceAll("command", "super")
    .replaceAll("cmd", "super")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const key = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  if (modifiers.some((modifier) => !MODIFIER_ORDER.includes(modifier as (typeof MODIFIER_ORDER)[number]))) {
    return undefined;
  }

  const isLetter = /^[a-z]$/.test(key);
  const isDigit = /^\d$/.test(key);
  const isFunction = /^f(?:[1-9]|1[0-2])$/.test(key);
  const isSpecial = SPECIAL_KEYS.has(key);
  const isSymbol = SYMBOL_KEYS.has(key);
  if (!isLetter && !isDigit && !isFunction && !isSpecial && !isSymbol) return undefined;

  // Bare printable keys would make normal editor input impossible.
  if (modifiers.length === 0 && !isFunction) return undefined;
  // Shift-only printable keys are also normal text input.
  if (modifiers.length === 1 && modifiers[0] === "shift" && (isLetter || isDigit || isSymbol)) {
    return undefined;
  }

  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return [...ordered, key === "pageup" ? "pageUp" : key === "pagedown" ? "pageDown" : key].join("+");
}

export function displayShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      if (process.platform === "darwin" && part.toLowerCase() === "alt") return "Option";
      return part.length === 1
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase()}${part.slice(1)}`;
    })
    .join("+");
}

export async function chooseShortcut(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) => {
      type Conflict = { description: string };
      type Phase =
        | { kind: "waiting" }
        | { kind: "preview"; normalized: string; conflicts: Conflict[] }
        | { kind: "error"; message: string };

      // Pi exposes its resolved built-in bindings here, but not shortcuts owned
      // by other extensions. Pi reports those collisions when it reloads.
      function findConflicts(kb: KeybindingsManager, shortcut: string): Conflict[] {
        const resolved = kb.getResolvedBindings();
        const result: Conflict[] = [];
        for (const [id, keys] of Object.entries(resolved)) {
          if (keys === undefined) continue;
          const keyList: string[] = Array.isArray(keys) ? keys : [keys];
          if (keyList.includes(shortcut)) {
            const def = kb.getDefinition(id as never);
            if (def?.description) result.push({ description: def.description });
          }
        }
        return result;
      }

      let phase: Phase = { kind: "waiting" };

      const container = new Container();
      const borderColor = (text: string) => theme.fg("accent", text);

      function rebuild(): void {
        container.clear();
        container.addChild(new DynamicBorder(borderColor));
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Record keyboard shortcut")), 1, 0),
        );
        container.addChild(new Spacer(1));

        if (phase.kind === "preview") {
          container.addChild(
            new Text(theme.fg("accent", displayShortcut(phase.normalized)), 1, 0),
          );
          if (phase.conflicts.length > 0) {
            container.addChild(
              new Text(
                theme.fg(
                  "warning",
                  `Built-in conflict: ${phase.conflicts.map((conflict) => conflict.description).join(", ")}. Pi may override or reject this shortcut.`,
                ),
                1,
                0,
              ),
            );
          }
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              `${keyHint("tui.select.confirm", "keep")}  ${rawKeyHint("d", "default")}  ${theme.fg("dim", "press another shortcut to replace")}  ${keyHint("tui.select.cancel", "cancel")}`,
              1,
              0,
            ),
          );
        } else {
          if (phase.kind === "error") {
            container.addChild(new Text(theme.fg("error", phase.message), 1, 0));
            container.addChild(new Spacer(1));
          }
          container.addChild(
            new Text(theme.fg("muted", "Press a key combination…"), 1, 0),
          );
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              `${rawKeyHint("d", `default (${displayShortcut(DEFAULT_SHORTCUT)})`)}  ${keyHint("tui.select.cancel", "cancel")}`,
              1,
              0,
            ),
          );
        }

        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder(borderColor));
      }

      rebuild();

      const component: Component = {
        wantsKeyRelease: false,

        render(width: number): string[] {
          return container
            .render(width)
            .map((line) => truncateToWidth(line, width, ""));
        },

        handleInput(data: string): void {
          if (keybindings.matches(data, "tui.select.cancel")) {
            done(undefined);
            return;
          }

          if (keybindings.matches(data, "tui.select.confirm")) {
            if (phase.kind === "preview") done(phase.normalized);
            return;
          }

          if (data === "d") {
            phase = {
              kind: "preview",
              normalized: DEFAULT_SHORTCUT,
              conflicts: findConflicts(keybindings, DEFAULT_SHORTCUT),
            };
            rebuild();
            tui.requestRender();
            return;
          }

          const parsed = parseKey(data);
          if (!parsed) return;

          const normalized = normalizeShortcut(parsed);
          if (!normalized) {
            phase = {
              kind: "error",
              message: `${displayShortcut(parsed)} is not valid. Use a modifier such as Ctrl or Alt, or a function key.`,
            };
          } else {
            phase = {
              kind: "preview",
              normalized,
              conflicts: findConflicts(keybindings, normalized),
            };
          }
          rebuild();
          tui.requestRender();
        },

        invalidate(): void {
          rebuild();
        },
      };

      return component;
    },
  );
}
