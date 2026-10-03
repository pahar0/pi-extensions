// Last verified working with Pi v1.0.1
// Generic resource manager for Pi extensions and skills.
import { basename, dirname, relative } from "node:path";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type PackageSource,
	type PathMetadata,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Scope = "global" | "project" | "package";
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
	metadata: PathMetadata;
}

interface ResourceConfig {
	type: ResourceType;
	plural: "extensions" | "skills";
	command: string;
	description: string;
	getProtectionReason?: (item: ManagedResource) => string | undefined;
	isHidden?: (item: ManagedResource) => boolean;
}

function resourceName(type: ResourceType, path: string): string {
	const fileName = basename(path);
	if (type === "skill" && fileName === "SKILL.md") return basename(dirname(path));
	if (type === "extension" && ["index.ts", "index.js"].includes(fileName)) return basename(dirname(path));
	return fileName.replace(/\.(?:md|ts|js)$/i, "");
}

function toManagedResource(type: ResourceType, resource: ResolvedResource): ManagedResource {
	const fileName = basename(resource.path);
	return {
		type,
		name: resourceName(type, resource.path),
		scope: resource.metadata.origin === "package"
			? "package"
			: resource.metadata.scope === "project" ? "project" : "global",
		kind: fileName === "SKILL.md" || ["index.ts", "index.js"].includes(fileName) ? "directory" : "file",
		status: resource.enabled ? "enabled" : "disabled",
		path: resource.path,
		metadata: resource.metadata,
	};
}

function sortResources(items: ManagedResource[]): ManagedResource[] {
	return items.sort((a, b) => {
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
		if (a.status !== b.status) return a.status.localeCompare(b.status);
		return a.name.localeCompare(b.name);
	});
}

async function scanAll(
	cwd: string,
	projectTrusted: boolean,
	config: ResourceConfig,
): Promise<{ items: ManagedResource[]; settingsManager: SettingsManager }> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const resources = config.type === "extension" ? resolved.extensions : resolved.skills;
	const items = sortResources(resources.map((resource) => toManagedResource(config.type, resource)));
	return {
		items: config.isHidden ? items.filter((item) => !config.isHidden!(item)) : items,
		settingsManager,
	};
}

function getDisplayFields(item: ManagedResource): { name: string; status: string; scope: string; kind: string } {
	return {
		name: item.name,
		status: item.status === "enabled" ? "ON" : "OFF",
		scope: item.scope,
		kind: item.kind === "file" ? "file" : "dir",
	};
}

async function selectManagedResource(
	ctx: ExtensionCommandContext,
	config: ResourceConfig,
	items: ManagedResource[],
): Promise<ManagedResource | null> {
	const rows = items.map((item) => ({ item, ...getDisplayFields(item) }));
	const nameHeader = "name";
	const statusHeader = "status";
	const scopeHeader = "scope";
	const kindHeader = "kind";
	const statusWidth = Math.max(statusHeader.length, ...rows.map((row) => row.status.length));
	const scopeWidth = Math.max(scopeHeader.length, ...rows.map((row) => row.scope.length));
	const kindWidth = Math.max(kindHeader.length, ...rows.map((row) => row.kind.length));

	return await ctx.ui.custom<ManagedResource | null>((tui, theme, keybindings, done) => {
		let selectedIndex = 0;
		let scrollOffset = 0;

		const moveSelection = (delta: number) => {
			selectedIndex = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
		};
		const enabledCount = items.filter((item) => item.status === "enabled").length;
		const disabledCount = items.length - enabledCount;

		return {
			render(width: number): string[] {
				const outerWidth = Math.max(1, width);
				const innerWidth = Math.max(1, outerWidth - 2);
				const terminalRows = tui.terminal?.rows ?? 24;
				const visibleRowCount = Math.max(4, terminalRows - 7);
				const maxOffset = Math.max(0, rows.length - visibleRowCount);
				const fixedColumnsWidth = 3 + 2 + 2 + statusWidth + 2 + scopeWidth + 2 + kindWidth;
				const effectiveNameWidth = Math.max(1, innerWidth - fixedColumnsWidth);

				const padPlain = (text: string, targetWidth: number): string => {
					const truncated = truncateToWidth(text, Math.max(0, targetWidth), "");
					return truncated + " ".repeat(Math.max(0, targetWidth - visibleWidth(truncated)));
				};
				const fit = (text: string, targetWidth: number): string => {
					const truncated = truncateToWidth(text, Math.max(0, targetWidth), "");
					return truncated + " ".repeat(Math.max(0, targetWidth - visibleWidth(truncated)));
				};
				const split = (left: string, right: string, targetWidth: number): string => {
					const rightWidth = visibleWidth(right);
					const fittedLeft = truncateToWidth(left, Math.max(0, targetWidth - rightWidth - 1), "…");
					const gap = Math.max(1, targetWidth - visibleWidth(fittedLeft) - rightWidth);
					return truncateToWidth(`${fittedLeft}${" ".repeat(gap)}${right}`, targetWidth, "");
				};
				const borderSegment = (targetWidth: number, title: string): string => {
					const label = targetWidth >= 4
						? ` ${truncateToWidth(title, Math.max(0, targetWidth - 3), "…")} `
						: "";
					const labelWidth = visibleWidth(label);
					return theme.fg("borderMuted", "─") +
						(label ? theme.fg("text", label) : "") +
						theme.fg("borderMuted", "─".repeat(Math.max(0, targetWidth - labelWidth - 1)));
				};

				if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
				if (selectedIndex >= scrollOffset + visibleRowCount) scrollOffset = selectedIndex - visibleRowCount + 1;
				scrollOffset = Math.max(0, Math.min(scrollOffset, maxOffset));

				const viewport = rows.slice(scrollOffset, scrollOffset + visibleRowCount);
				const scrollInfo = rows.length > visibleRowCount
					? ` · ${scrollOffset + 1}-${Math.min(rows.length, scrollOffset + visibleRowCount)}/${rows.length}`
					: "";
				const headerLeft = ` ${theme.bold(theme.fg("accent", capitalize(config.plural)))}`;
				const headerRight = theme.fg("dim", `${items.length} total · ${enabledCount} on · ${disabledCount} off `);
				const columnHeader =
					`     ${padPlain(nameHeader, effectiveNameWidth)}  ` +
					`${padPlain(statusHeader, statusWidth)}  ` +
					`${padPlain(scopeHeader, scopeWidth)}  ` +
					padPlain(kindHeader, kindWidth);
				const panelBorder = theme.fg("borderMuted", "│");
				const lines: string[] = [split(headerLeft, headerRight, outerWidth)];

				lines.push(
					theme.fg("borderMuted", "╭") +
						borderSegment(innerWidth, `${capitalize(config.type)} resources${scrollInfo}`) +
						theme.fg("borderMuted", "╮"),
				);
				lines.push(panelBorder + theme.fg("dim", fit(columnHeader, innerWidth)) + panelBorder);
				lines.push(
					theme.fg("borderMuted", "├") +
						theme.fg("borderMuted", "─".repeat(innerWidth)) +
						theme.fg("borderMuted", "┤"),
				);

				for (let index = 0; index < visibleRowCount; index++) {
					const row = viewport[index];
					if (!row) {
						lines.push(panelBorder + " ".repeat(innerWidth) + panelBorder);
						continue;
					}

					const selected = scrollOffset + index === selectedIndex;
					const marker = selected ? theme.fg("accent", " ❯ ") : "   ";
					const glyph = theme.fg(row.status === "ON" ? "success" : "dim", "■ ");
					const namePlain = padPlain(row.name, effectiveNameWidth);
					const name = row.status === "OFF"
						? theme.fg("dim", namePlain)
						: selected ? theme.fg("accent", namePlain) : theme.fg("text", namePlain);
					const status = theme.fg(row.status === "ON" ? "success" : "dim", padPlain(row.status, statusWidth));
					const scope = theme.fg(selected ? "accent" : "muted", padPlain(row.scope, scopeWidth));
					const kind = theme.fg(selected ? "accent" : "dim", padPlain(row.kind, kindWidth));
					lines.push(panelBorder + fit(`${marker}${glyph}${name}  ${status}  ${scope}  ${kind}`, innerWidth) + panelBorder);
				}

				lines.push(
					theme.fg("borderMuted", "╰") +
						theme.fg("borderMuted", "─".repeat(innerWidth)) +
						theme.fg("borderMuted", "╯"),
				);
				lines.push(truncateToWidth(theme.fg("dim", " ↑↓ navigate · enter select · esc close"), outerWidth, ""));
				return lines.map((line) => truncateToWidth(line, outerWidth, ""));
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
					done(rows[selectedIndex]?.item ?? null);
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) done(null);
			},
		};
	}, { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } });
}

function capitalize(text: string): string {
	return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function patternTarget(pattern: string): string {
	return ["!", "+", "-"].includes(pattern[0] ?? "") ? pattern.slice(1) : pattern;
}

function updatedPatterns(current: string[], pattern: string, enabled: boolean): string[] {
	return [
		...current.filter((entry) => patternTarget(entry) !== pattern),
		`${enabled ? "+" : "-"}${pattern}`,
	];
}

function setTopLevelResourceEnabled(
	settingsManager: SettingsManager,
	item: ManagedResource,
	enabled: boolean,
): void {
	if (item.metadata.scope !== "user") {
		throw new Error("Project resources are read-only here to avoid changing the application repository");
	}

	const key = item.type === "extension" ? "extensions" : "skills";
	const current = (settingsManager.getGlobalSettings()[key] ?? []) as string[];
	const baseDir = item.metadata.baseDir ?? getAgentDir();
	const updated = updatedPatterns(current, relative(baseDir, item.path), enabled);
	if (key === "extensions") settingsManager.setExtensionPaths(updated);
	else settingsManager.setSkillPaths(updated);
}

function setPackageResourceEnabled(
	settingsManager: SettingsManager,
	item: ManagedResource,
	enabled: boolean,
): void {
	if (item.metadata.scope !== "user") {
		throw new Error("Project package resources are read-only here to avoid changing the application repository");
	}

	const packages = [...(settingsManager.getGlobalSettings().packages ?? [])] as PackageSource[];
	const packageIndex = packages.findIndex((pkg) =>
		(typeof pkg === "string" ? pkg : pkg.source) === item.metadata.source,
	);
	if (packageIndex < 0) throw new Error(`Package source not found in global settings: ${item.metadata.source}`);

	let pkg = packages[packageIndex]!;
	if (typeof pkg === "string") {
		pkg = { source: pkg };
		packages[packageIndex] = pkg;
	}

	const key = item.type === "extension" ? "extensions" : "skills";
	const current = (pkg[key] ?? []) as string[];
	const baseDir = item.metadata.baseDir ?? dirname(item.path);
	pkg[key] = updatedPatterns(current, relative(baseDir, item.path), enabled);
	settingsManager.setPackages(packages);
}

function setResourceEnabled(
	settingsManager: SettingsManager,
	item: ManagedResource,
	enabled: boolean,
): void {
	if (item.metadata.origin === "package") {
		setPackageResourceEnabled(settingsManager, item, enabled);
	} else {
		setTopLevelResourceEnabled(settingsManager, item, enabled);
	}
}

function getProtectionReason(item: ManagedResource): string | undefined {
	if (item.metadata.scope === "project") {
		return "Project resources are read-only in this manager to avoid modifying .pi/settings.json";
	}
	return undefined;
}

function isHiddenExtension(item: ManagedResource): boolean {
	return item.type === "extension" && basename(item.path) === "resource-manager.ts";
}

async function persistSettings(settingsManager: SettingsManager): Promise<void> {
	await settingsManager.flush();
	const errors = settingsManager.drainErrors();
	if (errors.length > 0) throw errors[0]!.error;
}

async function reloadAndExit(ctx: ExtensionCommandContext, message: string): Promise<void> {
	ctx.ui.notify(message, "info");
	await ctx.reload();
}

async function runManager(ctx: ExtensionCommandContext, config: ResourceConfig): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify(`${capitalize(config.type)} manager requires TUI mode`, "warning");
		return;
	}

	while (true) {
		const { items, settingsManager } = await scanAll(ctx.cwd, ctx.isProjectTrusted(), config);

		if (items.length === 0) {
			ctx.ui.notify(`No custom global, project, or package ${config.plural} found`, "info");
			return;
		}

		const item = await selectManagedResource(ctx, config, items);
		if (!item) return;

		const protectionReason = config.getProtectionReason?.(item);
		if (protectionReason) {
			ctx.ui.notify(protectionReason, "info");
			continue;
		}

		const action = await ctx.ui.select(`Manage ${item.name}`, [item.status === "enabled" ? "Disable" : "Enable", "Back"]);
		if (!action || action === "Back") continue;

		try {
			if (action === "Enable") {
				setResourceEnabled(settingsManager, item, true);
				await persistSettings(settingsManager);
				await reloadAndExit(ctx, `Enabled ${item.name}`);
				return;
			}

			if (action === "Disable") {
				const ok = await ctx.ui.confirm(`Disable ${config.type}`, `Disable ${item.name}?`);
				if (!ok) continue;
				setResourceEnabled(settingsManager, item, false);
				await persistSettings(settingsManager);
				await reloadAndExit(ctx, `Disabled ${item.name}`);
				return;
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
		description: "Manage personal extension preferences",
		getProtectionReason,
		isHidden: isHiddenExtension,
	},
	{
		type: "skill",
		plural: "skills",
		command: "skills",
		description: "Manage personal skill preferences",
		getProtectionReason,
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
		description: "Manage personal extension and skill preferences",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Resource manager requires TUI mode", "warning");
				return;
			}
			const label = await ctx.ui.select("Manage resources", ["Extensions", "Skills", "Back"]);
			if (label === "Extensions") return runManager(ctx, configs[0]!);
			if (label === "Skills") return runManager(ctx, configs[1]!);
		},
	});
}
