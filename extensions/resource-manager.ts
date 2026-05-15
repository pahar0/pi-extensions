// Last verified working with Pi v0.74.0
// Generic resource manager for Pi extensions and skills.
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Scope = "global" | "project";
type Kind = "file" | "directory";
type Status = "enabled" | "disabled";
type ResourceType = "extension" | "skill";

interface ManagedResource {
	type: ResourceType;
	name: string;
	scope: Scope;
	kind: Kind;
	status: Status;
	path: string;
	entryPath: string;
}

interface ManagedResourceBulkAction {
	mode: "bulk";
	action: "enableAll" | "disableAll";
	label: string;
}

type ManagedResourceSelection = ManagedResource | ManagedResourceBulkAction;

interface ResourceConfig {
	type: ResourceType;
	plural: string;
	command: string;
	description: string;
	globalDir: () => string;
	projectDir: (cwd: string) => string;
	scan: (baseDir: string, scope: Scope, config: ResourceConfig) => Promise<ManagedResource[]>;
	setEnabled: (item: ManagedResource, enabled: boolean) => Promise<void>;
	isProtected?: (item: ManagedResource) => boolean;
	isHidden?: (item: ManagedResource) => boolean;
}

function getGlobalExtensionsDir(): string {
	return join(getAgentDir(), "extensions");
}

function getProjectExtensionsDir(cwd: string): string {
	return join(cwd, ".pi", "extensions");
}

function getGlobalSkillsDir(): string {
	return join(getAgentDir(), "skills");
}

function getProjectSkillsDir(cwd: string): string {
	return join(cwd, ".pi", "skills");
}

async function scanExtensions(baseDir: string, scope: Scope, config: ResourceConfig): Promise<ManagedResource[]> {
	if (!existsSync(baseDir)) return [];

	const dirents = await readdir(baseDir, { withFileTypes: true });
	const items: ManagedResource[] = [];

	for (const dirent of dirents) {
		const fullPath = join(baseDir, dirent.name);

		if (dirent.isFile()) {
			if (dirent.name.endsWith(".ts") && !dirent.name.endsWith(".d.ts")) {
				items.push({ type: config.type, name: dirent.name.slice(0, -3), scope, kind: "file", status: "enabled", path: fullPath, entryPath: fullPath });
				continue;
			}

			if (dirent.name.endsWith(".ts.disabled") && !dirent.name.endsWith(".d.ts.disabled")) {
				items.push({ type: config.type, name: dirent.name.slice(0, -12), scope, kind: "file", status: "disabled", path: fullPath.slice(0, -9), entryPath: fullPath });
			}
			continue;
		}

		if (dirent.isDirectory()) {
			const enabledEntry = join(fullPath, "index.ts");
			const disabledEntry = join(fullPath, "index.ts.disabled");

			if (existsSync(enabledEntry)) {
				items.push({ type: config.type, name: dirent.name, scope, kind: "directory", status: "enabled", path: fullPath, entryPath: enabledEntry });
				continue;
			}

			if (existsSync(disabledEntry)) {
				items.push({ type: config.type, name: dirent.name, scope, kind: "directory", status: "disabled", path: fullPath, entryPath: disabledEntry });
			}
		}
	}

	return sortResources(items);
}

function shouldSkipSkillDirectory(name: string): boolean {
	return name === "node_modules" || name === ".git" || name === ".hg" || name === ".svn";
}

async function scanSkillDirectories(baseDir: string, scope: Scope, config: ResourceConfig): Promise<ManagedResource[]> {
	if (!existsSync(baseDir)) return [];

	const items: ManagedResource[] = [];

	async function visit(dir: string): Promise<void> {
		const enabledEntry = join(dir, "SKILL.md");
		const disabledEntry = join(dir, "SKILL.md.disabled");

		if (dir !== baseDir && existsSync(enabledEntry)) {
			items.push({ type: config.type, name: basename(dir), scope, kind: "directory", status: "enabled", path: dir, entryPath: enabledEntry });
			return;
		}

		if (dir !== baseDir && existsSync(disabledEntry)) {
			items.push({ type: config.type, name: basename(dir), scope, kind: "directory", status: "disabled", path: dir, entryPath: disabledEntry });
			return;
		}

		const dirents = await readdir(dir, { withFileTypes: true });
		for (const dirent of dirents) {
			if (!dirent.isDirectory() || shouldSkipSkillDirectory(dirent.name)) continue;
			await visit(join(dir, dirent.name));
		}
	}

	await visit(baseDir);
	return items;
}

async function scanRootSkillFiles(baseDir: string, scope: Scope, config: ResourceConfig): Promise<ManagedResource[]> {
	if (!existsSync(baseDir)) return [];

	const dirents = await readdir(baseDir, { withFileTypes: true });
	const items: ManagedResource[] = [];

	for (const dirent of dirents) {
		if (!dirent.isFile()) continue;
		const fullPath = join(baseDir, dirent.name);

		if (dirent.name.endsWith(".md") && !dirent.name.endsWith(".d.md")) {
			items.push({ type: config.type, name: dirent.name.slice(0, -3), scope, kind: "file", status: "enabled", path: fullPath, entryPath: fullPath });
			continue;
		}

		if (dirent.name.endsWith(".md.disabled")) {
			items.push({ type: config.type, name: dirent.name.slice(0, -12), scope, kind: "file", status: "disabled", path: fullPath.slice(0, -9), entryPath: fullPath });
		}
	}

	return items;
}

async function scanSkills(baseDir: string, scope: Scope, config: ResourceConfig): Promise<ManagedResource[]> {
	const [files, directories] = await Promise.all([
		scanRootSkillFiles(baseDir, scope, config),
		scanSkillDirectories(baseDir, scope, config),
	]);
	return sortResources([...files, ...directories]);
}

function sortResources(items: ManagedResource[]): ManagedResource[] {
	return items.sort((a, b) => {
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
		if (a.status !== b.status) return a.status.localeCompare(b.status);
		return a.name.localeCompare(b.name);
	});
}

async function scanAll(cwd: string, config: ResourceConfig): Promise<ManagedResource[]> {
	const [globalItems, projectItems] = await Promise.all([
		config.scan(config.globalDir(), "global", config),
		config.scan(config.projectDir(cwd), "project", config),
	]);
	const items = sortResources([...globalItems, ...projectItems]);
	return config.isHidden ? items.filter((item) => !config.isHidden!(item)) : items;
}

function getDisplayFields(item: ManagedResource): { name: string; status: string; scope: string; kind: string } {
	return {
		name: item.name,
		status: item.status === "enabled" ? "ON" : "OFF",
		scope: item.scope === "global" ? "global" : "project",
		kind: item.kind === "file" ? "file" : "dir",
	};
}

async function selectManagedResource(
	ctx: ExtensionCommandContext,
	config: ResourceConfig,
	items: ManagedResource[],
): Promise<ManagedResourceSelection | null> {
	type Row =
		| { rowType: "action"; disabled: boolean; label: string; selection: ManagedResourceBulkAction; name: string; status: string; scope: string; kind: string }
		| { rowType: "separator" }
		| ({ rowType: "item"; item: ManagedResource } & ReturnType<typeof getDisplayFields>);

	const isProtected = config.isProtected ?? (() => false);
	const itemRows: Row[] = items.map((item) => ({ rowType: "item", item, ...getDisplayFields(item) }));
	const canEnableAll = items.some((item) => item.status === "disabled");
	const canDisableAll = items.some((item) => item.status === "enabled" && !isProtected(item));
	const rows: Row[] = [
		{ rowType: "action", disabled: !canEnableAll, label: "Enable all", selection: { mode: "bulk", action: "enableAll", label: "Enable all" }, name: "Enable all", status: canEnableAll ? "" : "all ON", scope: "", kind: "" },
		{ rowType: "action", disabled: !canDisableAll, label: "Disable all", selection: { mode: "bulk", action: "disableAll", label: "Disable all" }, name: "Disable all", status: canDisableAll ? "" : "all OFF", scope: "", kind: "" },
		{ rowType: "separator" },
		...itemRows,
	];
	const visibleRows = rows.flatMap((row) => row.rowType === "separator" ? [] : [row]);
	const nameHeader = "name";
	const statusHeader = "status";
	const scopeHeader = "scope";
	const kindHeader = "kind";
	const statusWidth = Math.max(statusHeader.length, ...visibleRows.map((row) => row.status.length));
	const scopeWidth = Math.max(scopeHeader.length, ...visibleRows.map((row) => row.scope.length));
	const kindWidth = Math.max(kindHeader.length, ...visibleRows.map((row) => row.kind.length));

	return await ctx.ui.custom<ManagedResourceSelection | null>((tui, theme, keybindings, done) => {
		let selectedIndex = rows.findIndex((row) => row.rowType !== "separator" && !(row.rowType === "action" && row.disabled));
		if (selectedIndex < 0) selectedIndex = 0;
		let scrollOffset = 0;

		const isSelectable = (index: number) => {
			const row = rows[index];
			return !!row && row.rowType !== "separator" && !(row.rowType === "action" && row.disabled);
		};
		const moveSelection = (delta: number) => {
			let next = selectedIndex;
			do {
				next = Math.max(0, Math.min(rows.length - 1, next + delta));
			} while (!isSelectable(next) && next !== selectedIndex && next > 0 && next < rows.length - 1);
			if (isSelectable(next)) selectedIndex = next;
		};

		const clampScrollOffset = (maxOffset: number) => {
			scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, maxOffset)));
		};

		return {
			render(width: number): string[] {
				const outerWidth = Math.max(30, width);
				const innerWidth = Math.max(10, outerWidth - 4);
				const hint = "↑↓ navigate • enter select • esc cancel";
				const fixedChromeLines = 4;
				const fixedBodyLines = 2;
				const maxOverlayHeight = Math.max(10, Math.floor((tui.terminal?.rows ?? 24) * 0.85));
				const visibleRowCount = Math.max(4, maxOverlayHeight - fixedChromeLines - fixedBodyLines);
				const maxOffset = Math.max(0, rows.length - visibleRowCount);
				const minNameWidth = 8;
				const nonNameWidth = 2 + 2 + statusWidth + 2 + scopeWidth + 2 + kindWidth;
				const effectiveNameWidth = Math.max(minNameWidth, innerWidth - nonNameWidth);
				const padPlain = (text: string, w: number): string => {
					const t = truncateToWidth(text, w, "");
					return t + " ".repeat(Math.max(0, w - t.length));
				};
				const header = `  ${padPlain(nameHeader, effectiveNameWidth)}  ${padPlain(statusHeader, statusWidth)}  ${padPlain(scopeHeader, scopeWidth)}  ${padPlain(kindHeader, kindWidth)}`;

				if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
				if (selectedIndex >= scrollOffset + visibleRowCount) scrollOffset = selectedIndex - visibleRowCount + 1;
				clampScrollOffset(maxOffset);

				const viewport = rows.slice(scrollOffset, scrollOffset + visibleRowCount);
				const scrollInfo = rows.length > visibleRowCount
					? ` rows ${scrollOffset + 1}-${Math.min(rows.length, scrollOffset + visibleRowCount)} / ${rows.length}`
					: "";

				const lines: string[] = [];
				lines.push(theme.fg("accent", `┌${"─".repeat(Math.max(0, outerWidth - 2))}┐`));
				lines.push(theme.fg("accent", "│ ") + theme.bold(padPlain(`${capitalize(config.plural)}${scrollInfo}`, innerWidth)) + theme.fg("accent", " │"));
				lines.push(theme.fg("accent", `├${"─".repeat(Math.max(0, outerWidth - 2))}┤`));
				lines.push(theme.fg("accent", "│ ") + theme.fg("dim", padPlain(header, innerWidth)) + theme.fg("accent", " │"));

				for (let i = 0; i < viewport.length; i++) {
					const rowIndex = scrollOffset + i;
					const row = viewport[i]!;
					if (row.rowType === "separator") {
						lines.push(theme.fg("accent", "│ ") + theme.fg("dim", padPlain("  " + "─".repeat(Math.max(0, innerWidth - 2)), innerWidth)) + theme.fg("accent", " │"));
						continue;
					}

					const isSelected = rowIndex === selectedIndex;
					const prefixPlain = isSelected ? "> " : "  ";
					const prefix = isSelected ? theme.fg("accent", prefixPlain) : prefixPlain;
					const namePlain = padPlain(row.name, effectiveNameWidth);
					const name = row.rowType === "action" && row.disabled
						? theme.fg("dim", namePlain)
						: row.rowType === "item" && row.status === "OFF"
							? theme.fg("dim", namePlain)
							: isSelected ? theme.fg("accent", theme.bold(namePlain)) : namePlain;
					const statusPlain = padPlain(row.status, statusWidth);
					const status = row.rowType === "action"
						? theme.fg(row.disabled ? "dim" : "muted", statusPlain)
						: row.status === "ON"
							? theme.fg("success", statusPlain)
							: theme.fg("dim", statusPlain);
					const scopePlain = padPlain(row.scope, scopeWidth);
					const scope = theme.fg(isSelected ? "accent" : "muted", scopePlain);
					const kindPlain = padPlain(row.kind, kindWidth);
					const kind = theme.fg(isSelected ? "accent" : "dim", kindPlain);
					const plainWidth = prefixPlain.length + effectiveNameWidth + 2 + statusWidth + 2 + scopeWidth + 2 + kindWidth;
					const trailingSpaces = " ".repeat(Math.max(0, innerWidth - plainWidth));
					lines.push(theme.fg("accent", "│ ") + `${prefix}${name}  ${status}  ${scope}  ${kind}${trailingSpaces}` + theme.fg("accent", " │"));
				}

				lines.push(theme.fg("accent", "│ ") + theme.fg("dim", padPlain(hint, innerWidth)) + theme.fg("accent", " │"));
				lines.push(theme.fg("accent", `└${"─".repeat(Math.max(0, outerWidth - 2))}┘`));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up")) {
					moveSelection(-1);
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					moveSelection(1);
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					const row = rows[selectedIndex];
					if (row?.rowType === "action" && !row.disabled) done(row.selection);
					else if (row?.rowType === "item") done(row.item);
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) done(null);
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "85%", margin: 1 } });
}

function capitalize(text: string): string {
	return text.slice(0, 1).toUpperCase() + text.slice(1);
}

async function setExtensionEnabled(item: ManagedResource, enabled: boolean): Promise<void> {
	if (item.kind === "file") {
		const from = enabled ? `${item.path}.disabled` : item.path;
		const to = enabled ? item.path : `${item.path}.disabled`;
		await rename(from, to);
		return;
	}

	const from = enabled ? join(item.path, "index.ts.disabled") : join(item.path, "index.ts");
	const to = enabled ? join(item.path, "index.ts") : join(item.path, "index.ts.disabled");
	await rename(from, to);
}

async function setSkillEnabled(item: ManagedResource, enabled: boolean): Promise<void> {
	if (item.kind === "file") {
		const from = enabled ? `${item.path}.disabled` : item.path;
		const to = enabled ? item.path : `${item.path}.disabled`;
		await rename(from, to);
		return;
	}

	const from = enabled ? join(item.path, "SKILL.md.disabled") : join(item.path, "SKILL.md");
	const to = enabled ? join(item.path, "SKILL.md") : join(item.path, "SKILL.md.disabled");
	await rename(from, to);
}

function isProtectedExtension(item: ManagedResource): boolean {
	return item.scope === "global" && ["resource-manager", "extensions", "skills"].includes(item.name);
}

function isHiddenExtension(item: ManagedResource): boolean {
	return item.scope === "global" && item.name === "resource-manager";
}

async function setAllEnabled(items: ManagedResource[], config: ResourceConfig, enabled: boolean): Promise<number> {
	const isProtected = config.isProtected ?? (() => false);
	const targets = items.filter((item) => {
		if (!enabled && isProtected(item)) return false;
		return item.status !== (enabled ? "enabled" : "disabled");
	});
	for (const item of targets) await config.setEnabled(item, enabled);
	return targets.length;
}

async function uninstall(item: ManagedResource): Promise<void> {
	if (item.kind === "file") {
		await rm(item.entryPath, { force: true });
		return;
	}
	await rm(item.path, { recursive: true, force: true });
}

async function reloadAndExit(ctx: ExtensionCommandContext, message: string): Promise<void> {
	ctx.ui.notify(message, "info");
	await ctx.reload();
}

async function runManager(ctx: ExtensionCommandContext, config: ResourceConfig): Promise<void> {
	while (true) {
		const items = await scanAll(ctx.cwd, config);

		if (items.length === 0) {
			ctx.ui.notify(`No custom global or project ${config.plural} found`, "info");
			return;
		}

		const item = await selectManagedResource(ctx, config, items);
		if (!item) return;

		if ("mode" in item) {
			const enabled = item.action === "enableAll";
			const verb = enabled ? "Enable" : "Disable";
			const ok = await ctx.ui.confirm(`${verb} all ${config.plural}`, `${verb} all custom global and project ${config.plural}?`);
			if (!ok) continue;

			try {
				const count = await setAllEnabled(items, config, enabled);
				if (count === 0) {
					ctx.ui.notify(`All ${config.plural} are already ${enabled ? "enabled" : "disabled"}`, "info");
					continue;
				}
				await reloadAndExit(ctx, `${enabled ? "Enabled" : "Disabled"} ${count} ${config.type}${count === 1 ? "" : "s"}`);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`${capitalize(config.type)} manager error: ${message}`, "error");
				continue;
			}
		}

		const protectedItem = config.isProtected?.(item) ?? false;
		const actions = protectedItem ? ["Back"] : [item.status === "enabled" ? "Disable" : "Enable", "Uninstall", "Back"];
		const action = await ctx.ui.select(`Manage ${item.name}`, actions);
		if (!action || action === "Back") continue;

		try {
			if (action === "Enable") {
				await config.setEnabled(item, true);
				await reloadAndExit(ctx, `Enabled ${item.name}`);
				return;
			}

			if (action === "Disable") {
				const ok = await ctx.ui.confirm(`Disable ${config.type}`, `Disable ${item.name}?`);
				if (!ok) continue;
				await config.setEnabled(item, false);
				await reloadAndExit(ctx, `Disabled ${item.name}`);
				return;
			}

			if (action === "Uninstall") {
				const ok = await ctx.ui.confirm(`Uninstall ${config.type}`, `Permanently delete ${item.name} (${basename(item.path)})?`);
				if (!ok) continue;
				await uninstall(item);
				if (item.status === "enabled") {
					await reloadAndExit(ctx, `Uninstalled ${item.name}`);
					return;
				}
				ctx.ui.notify(`Uninstalled ${item.name}`, "info");
				continue;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`${capitalize(config.type)} manager error: ${message}`, "error");
		}
	}
}

const configs: ResourceConfig[] = [
	{
		type: "extension",
		plural: "extensions",
		command: "extensions",
		description: "Manage custom global and project extensions",
		globalDir: getGlobalExtensionsDir,
		projectDir: getProjectExtensionsDir,
		scan: scanExtensions,
		setEnabled: setExtensionEnabled,
		isProtected: isProtectedExtension,
		isHidden: isHiddenExtension,
	},
	{
		type: "skill",
		plural: "skills",
		command: "skills",
		description: "Manage custom global and project skills",
		globalDir: getGlobalSkillsDir,
		projectDir: getProjectSkillsDir,
		scan: scanSkills,
		setEnabled: setSkillEnabled,
	},
];

export default function resourceManager(pi: ExtensionAPI) {
	for (const config of configs) {
		pi.registerCommand(config.command, {
			description: config.description,
			handler: async (_args, ctx) => runManager(ctx, config),
		});
	}

	pi.registerCommand("resources", {
		description: "Manage custom global and project extensions or skills",
		handler: async (_args, ctx) => {
			const label = await ctx.ui.select("Manage resources", ["Extensions", "Skills", "Back"]);
			if (label === "Extensions") return runManager(ctx, configs[0]!);
			if (label === "Skills") return runManager(ctx, configs[1]!);
		},
	});
}
