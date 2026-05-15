// Last verified working with Pi v0.74.0
import { completeSimple } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	createEditToolDefinition,
	createWriteToolDefinition,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SHORTCUT = "ctrl+space";
const STATUS_KEY = "mutation-guard";

const writePreviewToolDefinitions = new Map<string, ReturnType<typeof createWriteToolDefinition>>();
let gitDiffAvailable: boolean | undefined;

type WritableToolName = "edit" | "write";
type GuardedAction =
	| WritableToolName
	| "create-command"
	| "delete-command"
	| "overwrite-command"
	| "append-command"
	| "redirection-command"
	| "inplace-edit-command"
	| "permission-command"
	| "git-mutation-command"
	| "git-destructive-command"
	| "package-install-command"
	| "compound-cd-mutation"
	| "shell-wrapper-command"
	| "filesystem-format-command"
	| "attr-command"
	| "publish-command"
	| "python-mutation-command";

type EditBlock = {
	oldText?: unknown;
	newText?: unknown;
};

type Edit = { oldText: string; newText: string };


function normalizePath(path: unknown): string {
	if (typeof path !== "string" || path.trim().length === 0) return "(unknown path)";
	return path.startsWith("@") ? path.slice(1) : path;
}

const CREATE_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?mkdir\b/m,
	/(^|[^\w./-])(?:sudo\s+)?touch\b/m,
	/(^|[^\w./-])(?:sudo\s+)?ln\b/m,
	/(^|[^\w./-])(?:sudo\s+)?mktemp\b/m,
];

const DELETE_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?rm\b/m,
	/(^|[^\w./-])(?:sudo\s+)?unlink\b/m,
	/(^|[^\w./-])(?:sudo\s+)?rmdir\b/m,
	/(^|[^\w./-])(?:sudo\s+)?find\b[\s\S]*?\s-delete\b/m,
	/(^|[^\w./-])(?:sudo\s+)?shred\b/m,
];

const APPEND_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?tee\b[^\n]*\s-a\b/m,
];

const APPEND_REDIRECTION_RE = /(^|[^>])\d?>>\s*(\S+)/gm;
const OUTPUT_REDIRECTION_RE = /(^|[^<>])(?:\d?>\|?|&>|>&)\s*(\S+)/gm;
const FD_APPEND_REDIRECTION_RE = /(^|\s)\d>>\s*(\S+)/gm;

function isAllowedRedirectionTarget(target: string): boolean {
	const normalized = target.replace(/^(["'])(.*)\1$/, "$2");
	return normalized === "/dev/null" || /^&?\d+$/.test(normalized);
}

function readShellToken(text: string, start: number): string | undefined {
	let i = start;
	while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
	if (i >= text.length) return undefined;
	const quote = text[i];
	if (quote === "'" || quote === '"') {
		let value = "";
		i += 1;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\\" && quote === '"' && i + 1 < text.length) {
				value += text[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (ch === quote) return value;
			value += ch;
			i += 1;
		}
		return value;
	}
	const match = /^\S+/.exec(text.slice(i));
	return match?.[0];
}

function hasUnsafeRedirectionOutsideQuotes(segment: string, mode: "append" | "output"): boolean {
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;

	for (let i = 0; i < segment.length; i += 1) {
		const ch = segment[i];
		if (quote) {
			if (quote !== "'" && ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === quote) quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}

		let operatorStart = -1;
		let targetStart = -1;
		let isAppend = false;
		if (ch === ">") {
			// Ignore process substitution: >(command)
			if (segment[i + 1] === "(") continue;
			operatorStart = i;
			isAppend = segment[i + 1] === ">";
			targetStart = i + (isAppend || segment[i + 1] === "|" || segment[i + 1] === "&" ? 2 : 1);
		} else if (ch === "&" && segment[i + 1] === ">") {
			operatorStart = i;
			isAppend = false;
			targetStart = i + 2;
		}
		if (operatorStart < 0) continue;

		const previous = segment.slice(0, operatorStart).match(/\d*$/)?.[0] ?? "";
		const beforeFd = operatorStart - previous.length - 1;
		if (previous && beforeFd >= 0 && /[\w./-]/.test(segment[beforeFd] ?? "")) continue;
		if (mode === "append" && !isAppend) continue;
		if (mode === "output" && isAppend) continue;

		const target = readShellToken(segment, targetStart);
		if (!target || !isAllowedRedirectionTarget(target)) return true;
	}
	return false;
}

const OVERWRITE_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?truncate\b/m,
	/(^|[^\w./-])(?:sudo\s+)?dd\b/m,
	/(^|[^\w./-])(?:sudo\s+)?install\b/m,
	/(^|[^\w./-])(?:sudo\s+)?mv\b/m,
	/(^|[^\w./-])(?:sudo\s+)?cp\b/m,
	/(^|[^\w./-])(?:sudo\s+)?rsync\b[^\n]*\s--delete\b/m,
	/(^|[^\w./-])(?:sudo\s+)?rsync\b(?![^\n]*\s--dry-run\b)/m,
	/(^|[^\w./-])(?:sudo\s+)?tee\b(?![^\n]*\s-a\b)/m,
];

const INPLACE_EDIT_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?sed\b[^\n]*\s-i(?:\s|$)/m,
	/(^|[^\w./-])(?:sudo\s+)?perl\b[^\n]*\s-pi(?:\s|$)/m,
	/(^|[^\w./-])(?:sudo\s+)?find\b[\s\S]*?\s-exec\b[\s\S]*?\b(?:rm|sed|perl|mv|cp)\b/m,
	/(^|[^\w./-])(?:sudo\s+)?xargs\b[\s\S]*?\b(?:rm|sed|perl|mv|cp)\b/m,
];

const PERMISSION_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?chmod\b/m,
	/(^|[^\w./-])(?:sudo\s+)?chown\b/m,
	/(^|[^\w./-])(?:sudo\s+)?chgrp\b/m,
];

const GIT_MUTATION_COMMAND_PATTERNS = [
	/(^|[^\w./-])git\s+add\b/m,
	/(^|[^\w./-])git\s+rm\b/m,
	/(^|[^\w./-])git\s+mv\b/m,
	/(^|[^\w./-])git\s+apply\b/m,
	/(^|[^\w./-])git\s+commit\b/m,
	/(^|[^\w./-])git\s+stash\s+(?:push|save|pop|apply)\b/m,
	/(^|[^\w./-])git\s+checkout\b[^\n]*\s--\s*\S/m,
	/(^|[^\w./-])git\s+restore\b/m,
];

const GIT_DESTRUCTIVE_COMMAND_PATTERNS = [
	/(^|[^\w./-])git\s+clean\b[^\n]*\s-[a-zA-Z]*f/m,
	/(^|[^\w./-])git\s+reset\s+--hard\b/m,
	/(^|[^\w./-])git\s+checkout\s+--\s/m,
	/(^|[^\w./-])git\s+restore\b[^\n]*\s(?:--source\s+[^\s]+\s+)?(?:--worktree\s+)?\.(?:\s|$)/m,
	/(^|[^\w./-])git\s+push\b[^\n]*\s(?:-[a-zA-Z]*f\b|--force\b|--force-with-lease\b)/m,
	/(^|[^\w./-])git\s+branch\s+-[a-zA-Z]*D\b/m,
	/(^|[^\w./-])git\s+update-ref\s+-d\b/m,
];

const SOURCE_WRAPPER_PATTERNS = [
	// `source file` / `. file` runs arbitrary commands from a file we are not parsing here.
	// Match only when the wrapper appears at the beginning of a shell segment, not as
	// an argument such as `find . -type f`.
	/(^|[;&|])\s*source\s+\S/m,
	/(^|[;&|])\s*\.\s+\S/m,
];

const SHELL_C_WRAPPER_RE = /(^|[^\w./-])(?:bash|sh|zsh|ksh|fish|dash|ash)\s+([^\n]*?)\s-c\b([^\n]*)/m;
const SHELL_HEREDOC_RE = /(^|[^\w./-])(?:bash|sh|zsh|ksh|fish|dash|ash)\b[^\n]*<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/m;
const EVAL_WRAPPER_RE = /(^|[^\w./-])eval\b([^\n]*)/m;

const FILESYSTEM_FORMAT_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?mkfs(?:\.[a-z0-9]+)?\b/m,
	/(^|[^\w./-])(?:sudo\s+)?mknod\b/m,
	/(^|[^\w./-])(?:sudo\s+)?fdisk\b/m,
	/(^|[^\w./-])(?:sudo\s+)?parted\b/m,
	/(^|[^\w./-])(?:sudo\s+)?wipefs\b/m,
];

const ATTR_COMMAND_PATTERNS = [
	/(^|[^\w./-])(?:sudo\s+)?chattr\b/m,
	/(^|[^\w./-])(?:sudo\s+)?setfacl\b/m,
];

const PACKAGE_INSTALL_COMMAND_PATTERNS = [
	/(^|[^\w./-])npm\s+(?:i|install|add|remove|uninstall|ci)\b/m,
	/(^|[^\w./-])pnpm\s+(?:i|install|add|remove|uninstall)\b/m,
	/(^|[^\w./-])yarn\s+(?:install|add|remove)\b/m,
	/(^|[^\w./-])bun\s+(?:install|add|remove)\b/m,
	/(^|[^\w./-])cargo\s+(?:add|remove|update)\b/m,
];

const PUBLISH_COMMAND_PATTERNS = [
	/(^|[^\w./-])npm\s+publish\b/m,
	/(^|[^\w./-])yarn\s+publish\b/m,
	/(^|[^\w./-])pnpm\s+publish\b/m,
	/(^|[^\w./-])cargo\s+publish\b/m,
];

// Strip leading env-var assignments and known-safe wrappers (sudo, timeout, nice, …)
// so a wrapped destructive verb is still detected by the per-segment patterns.
const SAFE_WRAPPER_TOKENS =
	/^(?:sudo|doas|nohup|timeout|nice|ionice|taskset|stdbuf|env|command|builtin|exec)\b/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;

function stripSafeWrappers(segment: string): string {
	let cur = segment.replace(/^\s+/, "");
	let safety = 16;
	while (safety-- > 0) {
		const before = cur;
		// Strip env-var assignments: FOO=bar BAZ=qux command ...
		cur = cur.replace(ENV_ASSIGN_RE, "");
		// Strip leading wrapper command + its flags/values up to the next bare token.
		const wrapperMatch = SAFE_WRAPPER_TOKENS.exec(cur);
		if (wrapperMatch) {
			// Drop the wrapper word.
			cur = cur.slice(wrapperMatch[0].length).replace(/^\s+/, "");
			// Drop any flags belonging to the wrapper (e.g. `timeout -k 5 30`, `nice -n -10`).
			while (true) {
				const flag = /^-[A-Za-z][A-Za-z0-9-]*/.exec(cur);
				if (!flag) break;
				cur = cur.slice(flag[0].length).replace(/^\s+/, "");
				// If the next token looks like a flag value (number, duration, etc.), eat it too.
				const value = /^[\w.+:/=,-]+/.exec(cur);
				if (value && !/^-/.test(value[0])) {
					cur = cur.slice(value[0].length).replace(/^\s+/, "");
				}
			}
			// `timeout 30 cmd` — also eat a leading bare numeric duration.
			cur = cur.replace(/^\d+(?:\.\d+)?[smhd]?\s+/, "");
		}
		if (cur === before) break;
	}
	return cur;
}

function splitSegments(command: string): string[] {
	// Split on common shell separators, but only when they appear outside quoted
	// strings. This avoids false positives such as `rg "foo|install bar"`, where
	// `install` is search text rather than a shell command.
	const segments: string[] = [];
	let start = 0;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;

	function push(end: number): void {
		const segment = command.slice(start, end).trim();
		if (segment.length > 0) segments.push(segment);
	}

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote) {
			if (quote !== "'" && ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === quote) quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === ";") {
			push(i);
			start = i + 1;
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			push(i);
			i += 1;
			start = i + 1;
			continue;
		}
		if (ch === "|") {
			push(i);
			if (command[i + 1] === "|") i += 1;
			start = i + 1;
		}
	}

	push(command.length);
	return segments;
}

function maskShellQuotedText(text: string): string {
	let output = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] ?? "";
		if (quote) {
			if (quote === '"' && ch === "\\" && i + 1 < text.length) {
				output += "  ";
				i += 1;
				continue;
			}
			output += " ";
			if (ch === quote) quote = undefined;
			continue;
		}
		if (escaped) {
			output += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			output += ch;
			escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			output += " ";
			continue;
		}
		output += ch;
	}

	return output;
}

function unescapeDoubleQuotedShellText(text: string): string {
	return text.replace(/\\([\\"$`\n])/g, "$1");
}

function readShellWord(text: string): { value: string; rest: string; quoted: boolean } | undefined {
	const input = text.replace(/^\s+/, "");
	if (!input) return undefined;
	const quote = input[0];
	if (quote === "'" || quote === '"') {
		let value = "";
		let i = 1;
		while (i < input.length) {
			const ch = input[i];
			if (ch === "\\" && quote === '"' && i + 1 < input.length) {
				value += input.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (ch === quote) {
				return {
					value: quote === '"' ? unescapeDoubleQuotedShellText(value) : value,
					rest: input.slice(i + 1),
					quoted: true,
				};
			}
			value += ch;
			i += 1;
		}
		return undefined;
	}

	const match = /^\S+/.exec(input);
	if (!match) return undefined;
	return { value: match[0], rest: input.slice(match[0].length), quoted: false };
}

function extractShellWrapperPayloads(command: string): { payloads: string[]; unknownWrapper: boolean } {
	const payloads: string[] = [];
	let unknownWrapper = false;

	const shellMatch = SHELL_C_WRAPPER_RE.exec(command);
	if (shellMatch) {
		const word = readShellWord(shellMatch[3] ?? "");
		if (word?.value) payloads.push(word.value);
		else unknownWrapper = true;
	}

	const evalMatch = EVAL_WRAPPER_RE.exec(command);
	if (evalMatch) {
		const word = readShellWord(evalMatch[2] ?? "");
		if (word?.quoted && word.value) payloads.push(word.value);
		else unknownWrapper = true;
	}

	return { payloads, unknownWrapper };
}

const PYTHON_COMMAND_RE = /(^|[^\w./-])(?:(?:uv|poetry|pipenv)\s+run\s+)?python(?:\d+(?:\.\d+)?)?\b/m;
const PYTHON_HEREDOC_RE = /(^|[^\w./-])(?:(?:uv|poetry|pipenv)\s+run\s+)?python(?:\d+(?:\.\d+)?)?\b[^\n]*<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/m;
const PYTHON_MUTATION_PATTERNS = [
	/\b(?:Path\s*\([^)]*\)|\w+)\.write_(?:text|bytes)\s*\(/m,
	/\b(?:Path\s*\([^)]*\)|\w+)\.(?:unlink|rename|replace|mkdir|rmdir|touch|chmod|symlink_to|hardlink_to)\s*\(/m,
	/\bopen\s*\([^\n)]*,\s*["'][^"']*[wax+][^"']*["']/m,
	/\b(?:os|pathlib\.Path)\.(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir|removedirs|chmod|chown|truncate|symlink|link)\s*\(/m,
	/\bshutil\.(?:rmtree|copy|copy2|copyfile|copytree|move|chown)\s*\(/m,
	/\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(/m,
];

function hasPythonMutation(code: string): boolean {
	return PYTHON_MUTATION_PATTERNS.some((pattern) => pattern.test(code));
}

function extractHeredocPayloads(command: string, pattern: RegExp): string[] {
	const payloads: string[] = [];
	const lines = command.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const match = pattern.exec(lines[i] ?? "");
		if (!match) continue;
		const delimiter = match[3];
		const body: string[] = [];
		for (let j = i + 1; j < lines.length; j += 1) {
			const line = lines[j] ?? "";
			if (line.trim() === delimiter) {
				payloads.push(body.join("\n"));
				i = j;
				break;
			}
			body.push(line);
		}
	}
	return payloads;
}

function extractPythonHeredocPayloads(command: string): string[] {
	return extractHeredocPayloads(command, PYTHON_HEREDOC_RE);
}

function extractShellHeredocPayloads(command: string): string[] {
	return extractHeredocPayloads(command, SHELL_HEREDOC_RE);
}

function extractPythonCPayloads(command: string): string[] {
	const payloads: string[] = [];
	for (const segment of splitSegments(command)) {
		if (!PYTHON_COMMAND_RE.test(segment)) continue;
		const cFlag = /(?:^|\s)-c(?:\s+|=)([\s\S]*)/.exec(segment);
		if (!cFlag) continue;
		const word = readShellWord(cFlag[1] ?? "");
		if (word?.value) payloads.push(word.value);
	}
	return payloads;
}

function detectPythonMutationCommand(command: string): boolean {
	if (!PYTHON_COMMAND_RE.test(command)) return false;
	return [...extractPythonHeredocPayloads(command), ...extractPythonCPayloads(command)].some(hasPythonMutation);
}

const HEREDOC_START_RE = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g;

function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		kept.push(line);
		HEREDOC_START_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		const delimiters: string[] = [];
		while ((match = HEREDOC_START_RE.exec(line)) !== null) {
			if (match[2]) delimiters.push(match[2]);
		}
		for (const delimiter of delimiters) {
			for (let j = i + 1; j < lines.length; j += 1) {
				const candidate = lines[j] ?? "";
				if (candidate.trim() === delimiter) {
					i = j;
					break;
				}
			}
		}
	}
	return kept.join("\n");
}

function extractNestedShellCommands(command: string): string[] {
	const nestedCommands: string[] = [];

	for (let i = 0; i < command.length; i += 1) {
		if (command[i] === "`") {
			let j = i + 1;
			let content = "";
			while (j < command.length) {
				const ch = command[j];
				if (ch === "\\" && j + 1 < command.length) {
					content += command.slice(j, j + 2);
					j += 2;
					continue;
				}
				if (ch === "`") break;
				content += ch;
				j += 1;
			}
			if (j < command.length) {
				nestedCommands.push(content);
				i = j;
			}
			continue;
		}

		const isCommandSubstitution = command[i] === "$" && command[i + 1] === "(";
		const isProcessSubstitution = (command[i] === "<" || command[i] === ">") && command[i + 1] === "(";
		if (!isCommandSubstitution && !isProcessSubstitution) continue;

		let depth = 1;
		let j = i + 2;
		let quote: '"' | "'" | "`" | undefined;
		while (j < command.length && depth > 0) {
			const ch = command[j];
			if (ch === "\\") {
				j += 2;
				continue;
			}
			if (quote) {
				if (ch === quote) quote = undefined;
				j += 1;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				j += 1;
				continue;
			}
			if (ch === "$" && command[j + 1] === "(") {
				depth += 1;
				j += 2;
				continue;
			}
			if (ch === ")") depth -= 1;
			j += 1;
		}

		if (depth === 0) {
			nestedCommands.push(command.slice(i + 2, j - 1));
			i = j - 1;
		}
	}

	return nestedCommands;
}

function detectSegmentMutationAction(segment: string): GuardedAction | undefined {
	const stripped = stripSafeWrappers(segment);
	const commandText = maskShellQuotedText(stripped);
	if (DELETE_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "delete-command";
	if (INPLACE_EDIT_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "inplace-edit-command";
	if (PERMISSION_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "permission-command";
	if (FILESYSTEM_FORMAT_PATTERNS.some((p) => p.test(commandText))) return "filesystem-format-command";
	if (ATTR_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "attr-command";
	if (GIT_DESTRUCTIVE_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "git-destructive-command";
	if (PUBLISH_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "publish-command";
	if (GIT_MUTATION_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "git-mutation-command";
	if (PACKAGE_INSTALL_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "package-install-command";
	if (APPEND_COMMAND_PATTERNS.some((p) => p.test(commandText)) || hasUnsafeRedirectionOutsideQuotes(stripped, "append")) return "append-command";
	if (hasUnsafeRedirectionOutsideQuotes(stripped, "output")) return "redirection-command";
	if (OVERWRITE_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "overwrite-command";
	if (CREATE_COMMAND_PATTERNS.some((p) => p.test(commandText))) return "create-command";
	return undefined;
}

function detectGuardedBashAction(command: unknown): GuardedAction | undefined {
	if (typeof command !== "string") return undefined;

	if (detectPythonMutationCommand(command)) return "python-mutation-command";

	for (const payload of extractShellHeredocPayloads(command)) {
		const nestedMutation = detectGuardedBashAction(payload);
		if (nestedMutation) return nestedMutation;
	}

	const shellCommand = stripHeredocBodies(command);

	if (SOURCE_WRAPPER_PATTERNS.some((p) => p.test(shellCommand))) return "shell-wrapper-command";

	const wrapperPayloads = extractShellWrapperPayloads(shellCommand);
	for (const payload of wrapperPayloads.payloads) {
		const nestedMutation = detectGuardedBashAction(payload);
		if (nestedMutation) return nestedMutation;
	}
	if (wrapperPayloads.unknownWrapper) return "shell-wrapper-command";

	for (const nestedCommand of extractNestedShellCommands(shellCommand)) {
		const nestedMutation = detectGuardedBashAction(nestedCommand);
		if (nestedMutation) return nestedMutation;
	}

	const segments = splitSegments(shellCommand);
	const hasCd = segments.some((segment) => /(^|[^\w./-])cd\b/m.test(stripSafeWrappers(segment)));
	let firstMutation: GuardedAction | undefined;
	for (const segment of segments) {
		const mutation = detectSegmentMutationAction(segment);
		if (!mutation) continue;
		if (hasCd && mutation !== "git-destructive-command" && mutation !== "publish-command") return "compound-cd-mutation";
		firstMutation ??= mutation;
	}
	return firstMutation;
}

function isAcceptEditsAutoAllowed(_action: GuardedAction): boolean {
	// User preference: edit: accept bypasses this extension for every guarded
	// action, including detected bash mutations. Pi core permissions/sandboxing
	// may still apply independently.
	return true;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function isFileToolAction(action: GuardedAction): boolean {
	return action === "edit" || action === "write";
}

function buildRmPreview(command: string): string {
	const trimmed = command.trim();
	return trimmed.length > 0 ? trimmed : "(empty command)";
}

function formatEditPreviewError(displayPath: string, message: string): string {
	if (message.startsWith("File not found:")) {
		return `Current file does not exist: ${displayPath}`;
	}
	if (message.includes("Could not find the exact text") || message.includes("Could not find edits[")) {
		return `Preview failed for ${displayPath}: an oldText block does not match the current file contents exactly.`;
	}
	if (message.includes("must be unique") || message.includes("Found ")) {
		return `Preview failed for ${displayPath}: an oldText block matches multiple locations. Add more surrounding context.`;
	}
	if (message.includes("oldText must not be empty")) {
		return `Preview failed for ${displayPath}: an edit block has an empty oldText.`;
	}
	if (message.includes(" overlap in ")) {
		return `Preview failed for ${displayPath}: two edit blocks overlap. Merge them or target disjoint regions.`;
	}
	return `Preview unavailable for ${displayPath}: ${message}`;
}

function resolvePreviewPath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

async function renderGitStyleDiff(
	oldContent: string,
	newContent: string,
	displayPath: string,
	theme: ExtensionContext["ui"]["theme"],
): Promise<string | undefined> {
	if (gitDiffAvailable === false) return undefined;

	let dir: string | undefined;
	try {
		dir = await mkdtemp(join(tmpdir(), "mutation-guard-diff-"));
		const labelPath =
			displayPath
				.replace(/^[A-Za-z]:/, "")
				.replace(/^\/+/, "")
				.split("/")
				.filter((part) => part.length > 0 && part !== "." && part !== "..")
				.join("/") || "file";
		const oldPath = join(dir, "old", labelPath);
		const newPath = join(dir, "new", labelPath);
		await mkdir(dirname(oldPath), { recursive: true });
		await mkdir(dirname(newPath), { recursive: true });
		await writeFile(oldPath, oldContent, "utf8");
		await writeFile(newPath, newContent, "utf8");

		function changedTokenBg(text: string): string {
			return text.length > 0 ? theme.inverse(text) : text;
		}

		function addedLine(text: string): string {
			return theme.fg("toolDiffAdded", text);
		}

		function removedLine(text: string): string {
			return theme.fg("toolDiffRemoved", text);
		}

		function contextLine(text: string): string {
			return theme.fg("toolDiffContext", text);
		}

		function commonPrefixLength(a: string, b: string): number {
			let i = 0;
			while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
			return i;
		}

		function commonSuffixLength(a: string, b: string, prefixLength: number): number {
			let i = 0;
			while (
				i < a.length - prefixLength &&
				i < b.length - prefixLength &&
				a[a.length - 1 - i] === b[b.length - 1 - i]
			) {
				i += 1;
			}
			return i;
		}

		function highlightChangedMiddle(text: string, prefixLength: number, suffixLength: number): string {
			const start = text.slice(0, prefixLength);
			const middle = text.slice(prefixLength, text.length - suffixLength);
			const end = suffixLength > 0 ? text.slice(text.length - suffixLength) : "";
			return `${start}${changedTokenBg(middle)}${end}`;
		}

		function renderChangedPair(removed: string, added: string): { removed: string; added: string } {
			const removedText = removed.slice(1);
			const addedText = added.slice(1);
			const prefixLength = commonPrefixLength(removedText, addedText);
			const suffixLength = commonSuffixLength(removedText, addedText, prefixLength);
			return {
				removed: removedLine(`-${highlightChangedMiddle(removedText, prefixLength, suffixLength)}`),
				added: addedLine(`+${highlightChangedMiddle(addedText, prefixLength, suffixLength)}`),
			};
		}

		function renderDiffBody(lines: string[]): string {
			const rendered: string[] = [];
			let i = 0;
			while (i < lines.length) {
				if (!lines[i]?.startsWith("-")) {
					const line = lines[i] ?? "";
					rendered.push(line.startsWith("+") ? addedLine(line) : contextLine(line));
					i += 1;
					continue;
				}

				const removed: string[] = [];
				while (i < lines.length && lines[i]?.startsWith("-")) {
					removed.push(lines[i] ?? "");
					i += 1;
				}

				const added: string[] = [];
				while (i < lines.length && lines[i]?.startsWith("+")) {
					added.push(lines[i] ?? "");
					i += 1;
				}

				const pairCount = Math.min(removed.length, added.length);
				for (let j = 0; j < pairCount; j += 1) {
					const pair = renderChangedPair(removed[j]!, added[j]!);
					rendered.push(pair.removed, pair.added);
				}
				for (const line of removed.slice(pairCount)) rendered.push(removedLine(line));
				for (const line of added.slice(pairCount)) rendered.push(addedLine(line));
			}
			return rendered.join("\n");
		}

		function cleanOutput(output: string): string {
			const bodyLines = output
				.replaceAll("a/old/", "a/")
				.replaceAll("b/new/", "b/")
				.split("\n")
				.filter((line) => {
					return !(
						line.startsWith("diff --git ") ||
						line.startsWith("index ") ||
						line.startsWith("--- ") ||
						line.startsWith("+++ ") ||
						line.startsWith("@@") ||
						line.startsWith("new file ") ||
						line.startsWith("deleted file ") ||
						line.startsWith("similarity index ") ||
						line.startsWith("rename from ") ||
						line.startsWith("rename to ")
					);
				});
			return renderDiffBody(bodyLines).trimEnd();
		}

		try {
			const { stdout, stderr } = await execFileAsync(
				"git",
				["diff", "--no-index", "--color=never", join("old", labelPath), join("new", labelPath)],
				{ cwd: dir, maxBuffer: 10 * 1024 * 1024 },
			);
			gitDiffAvailable = true;
			return cleanOutput(`${stdout || ""}${stderr || ""}`);
		} catch (error) {
			const maybe = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
			if (maybe.code === 1) {
				gitDiffAvailable = true;
				const output = `${typeof maybe.stdout === "string" ? maybe.stdout : ""}${typeof maybe.stderr === "string" ? maybe.stderr : ""}`;
				return cleanOutput(output);
			}
			if (maybe.code === "ENOENT") gitDiffAvailable = false;
			return undefined;
		}
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true });
	}
}

function getWritePreviewToolDefinition(cwd: string): ReturnType<typeof createWriteToolDefinition> {
	let writeDef = writePreviewToolDefinitions.get(cwd);
	if (writeDef) return writeDef;

	writeDef = createWriteToolDefinition(cwd);
	writePreviewToolDefinitions.set(cwd, writeDef);
	return writeDef;
}

async function buildEditPreview(
	input: { path?: unknown; edits?: EditBlock[] },
	ctx: ExtensionContext,
): Promise<string> {
	const displayPath = normalizePath(input.path);
	const edits: Edit[] = (Array.isArray(input.edits) ? input.edits : []).map((edit) => ({
		oldText: typeof edit?.oldText === "string" ? normalizeToLF(edit.oldText) : "",
		newText: typeof edit?.newText === "string" ? normalizeToLF(edit.newText) : "",
	}));

	if (edits.length === 0) {
		return `Preview unavailable for ${displayPath}: no edits provided.`;
	}

	try {
		let previewContent: string | undefined;
		const absolutePath = resolvePreviewPath(ctx.cwd, displayPath);
		const originalContent = await readFile(absolutePath, "utf8");
		const editDef = createEditToolDefinition(ctx.cwd, {
			operations: {
				access: async (absolutePath: string) => {
					await access(absolutePath, constants.R_OK | constants.W_OK);
				},
				readFile: async (absolutePath: string) => readFile(absolutePath),
				writeFile: async (_absolutePath: string, content: string) => {
					// Dry-run preview only. Reuse Pi's exact edit semantics without
					// mutating the original file, then render the captured result via git.
					previewContent = content;
				},
			},
		});
		const result = await editDef.execute(
			"mutation-preview",
			{ path: displayPath, edits } as never,
			undefined,
			undefined,
			ctx,
		);
		const gitDiff = previewContent === undefined ? undefined : await renderGitStyleDiff(originalContent, previewContent, displayPath, ctx.ui.theme);
		if (gitDiff) return gitDiff;
		const diff = ((result as { details?: { diff?: string } }).details?.diff ?? "").trim();
		if (!diff) {
			return `No preview diff for ${displayPath}.`;
		}
		return renderTerminalDiff(diff, ctx.ui.theme);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatEditPreviewError(displayPath, message);
	}
}

function renderWritePreviewUsingPi(
	input: { path?: unknown; content?: unknown },
	ctx: ExtensionContext,
): string {
	if (!ctx.hasUI) {
		return `Write ${normalizePath(input.path)} (UI unavailable for formatted preview)`;
	}

	const writeDef = getWritePreviewToolDefinition(ctx.cwd);
	if (!writeDef.renderCall) {
		return `Write ${normalizePath(input.path)} (write renderer unavailable)`;
	}

	const args = {
		path: normalizePath(input.path),
		content: typeof input.content === "string" ? input.content : "",
	};

	const component = writeDef.renderCall(args as never, ctx.ui.theme, {
		args,
		state: {},
		lastComponent: undefined,
		invalidate() {},
		toolCallId: "mutation-preview",
		cwd: ctx.cwd,
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	} as never);

	const previewWidth = Math.max(40, process.stdout.columns ?? 100);
	const rendered = component.render(previewWidth);
	if (rendered.length <= 1) return "No additional write preview.";
	return rendered.slice(1).join("\n");
}

async function buildWritePreview(
	input: { path?: unknown; content?: unknown },
	ctx: ExtensionContext,
): Promise<string> {
	const rendered = renderWritePreviewUsingPi(input, ctx);
	return rendered;
}

async function buildPreview(
	action: GuardedAction,
	input: { path?: unknown; content?: unknown; edits?: EditBlock[]; command?: unknown },
	ctx: ExtensionContext,
): Promise<string> {
	try {
		if (action === "write") return buildWritePreview(input, ctx);
		if (action === "edit") return buildEditPreview(input, ctx);
		return buildRmPreview(typeof input.command === "string" ? input.command : "");
	} catch (error) {
		const subject = action === "delete-command" ? "deletion command" : normalizePath(input.path);
		const message = error instanceof Error ? error.message : String(error);
		return `Preview unavailable for ${subject}: ${message}`;
	}
}

type ApprovalResult = {
	action: "allow" | "block" | "abort";
	note?: string;
};

function getPromptTitle(action: GuardedAction): string {
	if (action === "create-command") return "Confirm file creation command";
	if (action === "delete-command") return "Confirm deletion command";
	if (action === "overwrite-command") return "Confirm overwrite command";
	if (action === "append-command") return "Confirm append command";
	if (action === "redirection-command") return "Confirm output redirection";
	if (action === "inplace-edit-command") return "Confirm in-place edit command";
	if (action === "permission-command") return "Confirm permission change";
	if (action === "git-mutation-command") return "Confirm git mutation command";
	if (action === "git-destructive-command") return "Confirm destructive git command";
	if (action === "package-install-command") return "Confirm package install command";
	if (action === "compound-cd-mutation") return "Confirm compound mutation command";
	if (action === "shell-wrapper-command") return "Confirm shell wrapper command";
	if (action === "filesystem-format-command") return "Confirm filesystem format command";
	if (action === "attr-command") return "Confirm attribute change";
	if (action === "publish-command") return "Confirm publish command";
	if (action === "python-mutation-command") return "Confirm Python file mutation";
	if (action === "write") return "Confirm file write";
	return "Confirm file edit";
}

function getToolDescription(action: GuardedAction, input: { path?: unknown }): string {
	if (action === "create-command") return "file creation command";
	if (action === "delete-command") return "deletion command";
	if (action === "overwrite-command") return "overwrite command";
	if (action === "append-command") return "append command";
	if (action === "redirection-command") return "output redirection command";
	if (action === "inplace-edit-command") return "in-place edit command";
	if (action === "permission-command") return "permission change command";
	if (action === "git-mutation-command") return "git command that changes the working tree or index";
	if (action === "git-destructive-command") return "destructive git command";
	if (action === "package-install-command") return "package manager command that changes dependency files";
	if (action === "compound-cd-mutation") return "compound command that changes directories before mutating files";
	if (action === "shell-wrapper-command") return "shell wrapper command (bash -c / eval / source)";
	if (action === "filesystem-format-command") return "filesystem format command";
	if (action === "attr-command") return "file attribute change command";
	if (action === "publish-command") return "package publish command";
	if (action === "python-mutation-command") return "Python code that may mutate files";
	const path = normalizePath(input.path);
	if (action === "write") return `write ${path}`;
	return `Edit ${path}`;
}

function trimLeadingEmptyLines(text: string): string {
	const lines = text.split("\n");
	while (lines.length > 0 && lines[0]!.trim().length === 0) lines.shift();
	return lines.join("\n");
}

function clearBlue(text: string): string {
	return `\x1b[38;2;102;170;255m${text}\x1b[39m`;
}

function previewBg(text: string): string {
	return text;
}

function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	const visibleLength = visibleWidth(truncated);
	return visibleLength >= width ? truncated : `${truncated}${" ".repeat(width - visibleLength)}`;
}

function subtleHint(text: string): string {
	return `\x1b[38;2;115;115;115m${text}\x1b[39m`;
}

function renderTerminalDiff(diff: string, theme: ExtensionContext["ui"]["theme"]): string {
	return diff
		.replace(/\s+$/g, "")
		.split("\n")
		.map((line) => {
			if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
			if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
			return theme.fg("toolDiffContext", line);
		})
		.join("\n");
}

async function generateToolExplanation(
	action: GuardedAction,
	toolDescription: string,
	preview: string,
	ctx: ExtensionContext,
): Promise<string> {
	const model = ctx.model;
	if (!model) {
		return "Explanation unavailable: no model is currently selected.";
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		return `Explanation unavailable: ${auth.error}`;
	}
	if (!auth.apiKey) {
		return `Explanation unavailable: no API key available for ${model.provider}/${model.id}.`;
	}

	const prompt = [
		"Explain this proposed coding-agent tool invocation for a user approval dialog.",
		"Return exactly three brief paragraphs, with at most one sentence per paragraph:",
		"1. What it will do.",
		"2. Why the agent may want to do it.",
		"3. Risk level (Low, Med, or High) and the main risk.",
		"Be concise, user-facing, and avoid unnecessary detail.",
		"",
		`Action type: ${action}`,
		`Tool: ${toolDescription}`,
		"",
		"<preview>",
		preview,
		"</preview>",
	].join("\n");

	const response = await completeSimple(
		model,
		{
			systemPrompt:
				"You explain proposed coding-agent actions for user approval dialogs in brief, clear, user-facing language.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: ctx.signal,
			// Explicitly request no thinking/reasoning for this lightweight UI explanation.
			onPayload: async (payload) => {
				if (!payload || typeof payload !== "object") return payload;
				const next = { ...(payload as Record<string, unknown>) };
				if ("reasoning" in next) next.reasoning = { effort: "none" };
				if ("thinking" in next) next.thinking = { enabled: false, budgetTokens: 0 };
				if ("thinking_enabled" in next) next.thinking_enabled = false;
				if ("thinkingEnabled" in next) next.thinkingEnabled = false;
				if ("thinkingBudgetTokens" in next) next.thinkingBudgetTokens = 0;
				return next;
			},
		},
	);

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		const message = response.errorMessage?.trim() || `request ended with ${response.stopReason}`;
		return `Explanation unavailable: ${message}`;
	}

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text.trim())
		.filter((block) => block.length > 0)
		.join("\n\n");

	return text || "Explanation unavailable: the model returned an empty response.";
}

async function promptForApproval(
	action: GuardedAction,
	toolDescription: string,
	preview: string,
	ctx: ExtensionContext,
	autoAllow?: { isEnabled: () => boolean; toggle: () => void },
): Promise<ApprovalResult> {
	const title = getPromptTitle(action);
	const baseLines = trimLeadingEmptyLines(preview).replace(/\t/g, "    ").split("\n");
	const customChoice = await ctx.ui.custom<ApprovalResult | undefined>((tui, theme, keybindings, done) => {
		let active = true;
		let scrollOffset = 0;
		let optionIndex = 0;
		let editMode = false;
		let explanationVisible = false;
		let explanationLoading = false;
		let explanationText: string | undefined;
		let explanationError: string | undefined;
		let loadingFrame = 0;
		let loadingTimer: ReturnType<typeof setInterval> | undefined;
		let explanationPromise: Promise<string> | undefined;
		const notes = ["", ""];

		const editorTheme: EditorTheme = {
			borderColor: (s) => clearBlue(s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);
		editor.onSubmit = (value) => {
			notes[optionIndex] = value;
			completeResult(optionIndex === 0 ? "allow" : "block");
		};
		let cachedWidth = -1;
		let cachedTopBorder = "";
		let cachedSeparator = "";
		let cachedHeaderLine = "";
		let cachedDescriptionLine = "";
		let cachedWrappedPreviewWidth = -1;
		let cachedWrappedPreviewLines: string[] | undefined;
		let cachedExplanationKey = "";
		let cachedExplanationWidth = -1;
		let cachedExplanationLines: string[] | undefined;

		function stopLoadingAnimation() {
			if (loadingTimer) {
				clearInterval(loadingTimer);
				loadingTimer = undefined;
			}
		}

		function startLoadingAnimation() {
			if (loadingTimer) return;
			loadingTimer = setInterval(() => {
				if (!active || !explanationVisible || !explanationLoading) {
					stopLoadingAnimation();
					return;
				}
				loadingFrame = (loadingFrame + 1) % 3;
				refresh();
			}, 250);
		}

		function finish(result: ApprovalResult) {
			active = false;
			stopLoadingAnimation();
			done(result);
		}

		function refresh() {
			if (!active) return;
			tui.requestRender();
		}

		function wrapLines(textLines: string[], width: number): string[] {
			const wrapped: string[] = [];
			for (const line of textLines) {
				const parts = wrapTextWithAnsi(line, Math.max(1, width));
				if (parts.length === 0) wrapped.push("");
				else wrapped.push(...parts);
			}
			return wrapped;
		}

		function getStaticLines(width: number): {
			topBorder: string;
			separator: string;
			headerLine: string;
			descriptionLine: string;
		} {
			if (cachedWidth !== width) {
				cachedWidth = width;
				cachedTopBorder = clearBlue("─".repeat(width));
				cachedSeparator = theme.fg("dim", "╌".repeat(width));
				cachedHeaderLine = truncateToWidth(theme.bold(title), width);
				cachedDescriptionLine = truncateToWidth(theme.fg("muted", toolDescription), width);
			}
			return {
				topBorder: cachedTopBorder,
				separator: cachedSeparator,
				headerLine: cachedHeaderLine,
				descriptionLine: cachedDescriptionLine,
			};
		}

		function getWrappedPreviewLines(width: number): string[] {
			if (cachedWrappedPreviewWidth !== width || !cachedWrappedPreviewLines) {
				cachedWrappedPreviewWidth = width;
				cachedWrappedPreviewLines = wrapLines(baseLines, width);
			}
			return cachedWrappedPreviewLines;
		}

		function getExplanationLines(width: number): string[] {
			const explanationKey = explanationLoading
				? `loading:${loadingFrame}`
				: explanationError
					? `error:${explanationError}`
					: `text:${explanationText ?? ""}`;
			if (cachedExplanationWidth !== width || cachedExplanationKey !== explanationKey || !cachedExplanationLines) {
				cachedExplanationWidth = width;
				cachedExplanationKey = explanationKey;
				cachedExplanationLines = explanationLoading
					? [`Loading explanation${".".repeat(loadingFrame + 1)}`]
					: explanationError
						? [theme.fg("error", explanationError)]
						: wrapLines((explanationText ?? "").split("\n"), width);
			}
			return cachedExplanationLines;
		}

		function clearRenderCaches(): void {
			cachedWidth = -1;
			cachedTopBorder = "";
			cachedSeparator = "";
			cachedHeaderLine = "";
			cachedDescriptionLine = "";
			cachedWrappedPreviewWidth = -1;
			cachedWrappedPreviewLines = undefined;
			cachedExplanationKey = "";
			cachedExplanationWidth = -1;
			cachedExplanationLines = undefined;
		}

		function renderOption(index: number): string[] {
			const selected = index === optionIndex;
			const label = index === 0 ? "Yes" : "No";
			const prefix = selected ? clearBlue("❯ ") : "  ";
			const base = selected ? clearBlue(theme.bold(`${index + 1}. ${label}`)) : `${index + 1}. ${label}`;
			const note = (notes[index] ?? "").trim();
			const showInlineNote = note.length > 0 && !(editMode && index === optionIndex);
			if (!showInlineNote) return [prefix + base];
			const noteLines = note.split("\n");
			return [
				prefix + base + theme.fg("text", `, ${noteLines[0]}`),
				...noteLines.slice(1).map((line) => "  " + theme.fg("text", line)),
			];
		}

		function completeResult(actionName: "allow" | "block") {
			const note = (notes[optionIndex] ?? "").trim();
			if (actionName === "block" && note.length === 0) {
				finish({ action: "abort" });
				return;
			}
			finish({ action: actionName, note: note.length > 0 ? note : undefined });
		}

		function toggleExplanation() {
			explanationVisible = !explanationVisible;
			if (!explanationVisible) stopLoadingAnimation();
			refresh();
			if (explanationVisible && explanationLoading) startLoadingAnimation();
			if (explanationVisible && !explanationText && !explanationError && !explanationLoading) {
				explanationLoading = true;
				loadingFrame = 0;
				startLoadingAnimation();
				refresh();
				explanationPromise ??= generateToolExplanation(action, toolDescription, preview, ctx);
				void explanationPromise
					.then((text) => {
						if (!active) return;
						explanationText = text;
						explanationError = undefined;
					})
					.catch((error: unknown) => {
						if (!active) return;
						explanationError = error instanceof Error ? error.message : String(error);
					})
					.finally(() => {
						if (!active) return;
						explanationLoading = false;
						stopLoadingAnimation();
						refresh();
					});
			}
		}

		return {
			invalidate() {
				clearRenderCaches();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					if (editMode) {
						notes[optionIndex] = editor.getText();
						editMode = false;
						refresh();
						return;
					}
					finish({ action: "abort" });
					return;
				}

				if (matchesKey(data, Key.ctrl("e"))) {
					toggleExplanation();
					return;
				}

				if (matchesKey(data, Key.ctrl("space")) && autoAllow) {
					autoAllow.toggle();
					refresh();
					return;
				}

				if (editMode) {
					if (keybindings.matches(data, "tui.input.tab")) {
						notes[optionIndex] = editor.getText();
						editMode = false;
						refresh();
						return;
					}
					if (keybindings.matches(data, "tui.select.pageUp")) {
						scrollOffset = Math.max(0, scrollOffset - 1);
						refresh();
						return;
					}
					if (keybindings.matches(data, "tui.select.pageDown")) {
						scrollOffset += 1;
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (keybindings.matches(data, "tui.select.up")) {
					optionIndex = optionIndex === 0 ? 1 : optionIndex - 1;
					refresh();
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					optionIndex = optionIndex === 1 ? 0 : optionIndex + 1;
					refresh();
					return;
				}
				if (keybindings.matches(data, "tui.select.pageUp")) {
					scrollOffset = Math.max(0, scrollOffset - 1);
					refresh();
					return;
				}
				if (keybindings.matches(data, "tui.select.pageDown")) {
					scrollOffset += 1;
					refresh();
					return;
				}
				if (data === "g") {
					scrollOffset = 0;
					refresh();
					return;
				}
				if (data === "G") {
					scrollOffset = Number.MAX_SAFE_INTEGER;
					refresh();
					return;
				}
				if (keybindings.matches(data, "tui.input.tab")) {
					editor.setText(notes[optionIndex] ?? "");
					editMode = true;
					refresh();
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					completeResult(optionIndex === 0 ? "allow" : "block");
				}
			},
			render(width: number): string[] {
				const outerWidth = Math.max(1, width);
				const overlayHeightBudget = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * 0.85));
				const wrappedPreview = getWrappedPreviewLines(outerWidth);
				const { topBorder, separator, headerLine, descriptionLine } = getStaticLines(outerWidth);
				const explainToggleLabel = explanationVisible ? "Ctrl+E hide" : "Ctrl+E explain";

				function fitOptionalBlock(blockLines: string[], available: number): string[] {
					if (blockLines.length === 0 || available <= 0) return [];
					if (blockLines.length <= available) return blockLines;
					if (available === 1) return [truncateToWidth(theme.fg("dim", "..."), outerWidth)];
					return [
						...blockLines.slice(0, available - 1),
						truncateToWidth(theme.fg("dim", "..."), outerWidth),
					];
				}

				const baseQuestionLines = [
					"",
					truncateToWidth(theme.fg("text", "Do you want to proceed?"), outerWidth),
					...renderOption(0).map((line) => truncateToWidth(line, outerWidth)),
					...renderOption(1).map((line) => truncateToWidth(line, outerWidth)),
				];
				const rawExplanationLines = explanationVisible
					? ["", ...getExplanationLines(outerWidth).map((line) => truncateToWidth(line, outerWidth))]
					: [];
				const rawEditorLines = editMode
					? [
						"",
						truncateToWidth(theme.fg("muted", "Your note:"), outerWidth),
						...editor.render(outerWidth).map((line) => truncateToWidth(line, outerWidth)),
					]
					: [];
				const fixedNonPreviewLines = 6 + baseQuestionLines.length;
				const fixedNonPreviewWithHelp = fixedNonPreviewLines + 2;
				let optionalBudget = Math.max(0, overlayHeightBudget - fixedNonPreviewWithHelp);
				const editorLines = fitOptionalBlock(rawEditorLines, optionalBudget);
				optionalBudget -= editorLines.length;
				const explanationLines = fitOptionalBlock(rawExplanationLines, optionalBudget);

				const nonPreviewCount =
					6 + explanationLines.length + baseQuestionLines.length + editorLines.length + 2;
				const previewHeight = Math.max(0, Math.min(wrappedPreview.length || 1, overlayHeightBudget - nonPreviewCount));
				const maxOffset = Math.max(0, wrappedPreview.length - previewHeight);
				scrollOffset = Math.min(scrollOffset, maxOffset);
				const canScroll = maxOffset > 0;
				const viewport = wrappedPreview.slice(scrollOffset, scrollOffset + previewHeight);
				const scrollHint = canScroll ? " • PgUp/PgDn scroll • g/G jump" : "";
				const helpLine = subtleHint(
					editMode
						? "Enter submit • Esc/Tab exit edit"
						: `Enter allow • Esc block • ${explainToggleLabel} • Tab to amend${scrollHint}`,
				);

				const lines: string[] = [];
				lines.push(topBorder);
				lines.push(headerLine);
				lines.push(descriptionLine);
				lines.push("");
				lines.push(separator);

				for (let i = 0; i < previewHeight; i += 1) {
					const line = viewport[i] ?? "";
					lines.push(previewBg(padToWidth(truncateToWidth(line, outerWidth), outerWidth)));
				}
				lines.push(separator);
				lines.push(...explanationLines);
				lines.push(...baseQuestionLines);
				lines.push(...editorLines);
				lines.push("");
				lines.push(truncateToWidth(helpLine, outerWidth));
				return lines.slice(0, overlayHeightBudget);
			},
		};
	});

	if (customChoice) return customChoice;

	const selectChoice = await ctx.ui.select(`${title} — ${toolDescription}\n\n${preview}`, [
		"Allow",
		"Block",
	]);
	if (selectChoice === "Allow") return { action: "allow" };
	return { action: "abort" };
}

export default function fileMutationGuardExtension(pi: ExtensionAPI) {
	let allowEnabled = false;

	function updateStatus(ctx?: ExtensionContext): void {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const value = allowEnabled ? theme.fg("warning", "accept") : theme.fg("dim", "ask");
		ctx.ui.setStatus(STATUS_KEY, `${value} ${theme.fg("dim", `(${SHORTCUT})`)}`);
	}

	function setAllowEnabled(enabled: boolean, ctx?: ExtensionContext): void {
		allowEnabled = enabled;
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		setAllowEnabled(false, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Toggle automatic approval for ordinary file edits; dangerous or ambiguous mutations still ask",
		handler: async (ctx) => {
			setAllowEnabled(!allowEnabled, ctx);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		let action: GuardedAction | undefined;
		let input: { path?: unknown; content?: unknown; edits?: EditBlock[]; command?: unknown } | undefined;
		let blockReasonTarget = "";

		if (isToolCallEventType("edit", event)) {
			action = "edit";
			input = {
				path: event.input.path,
				edits: event.input.edits,
			};
			blockReasonTarget = normalizePath(event.input.path);
		} else if (isToolCallEventType("write", event)) {
			action = "write";
			input = {
				path: event.input.path,
				content: event.input.content,
			};
			blockReasonTarget = normalizePath(event.input.path);
		} else if (isToolCallEventType("bash", event)) {
			action = detectGuardedBashAction(event.input.command);
			if (!action) return undefined;
			input = { command: event.input.command };
			blockReasonTarget = getToolDescription(action, {});
		} else {
			return undefined;
		}

		if (allowEnabled && isAcceptEditsAutoAllowed(action)) {
			return undefined;
		}

		if (!ctx.hasUI) {
			const subject = isFileToolAction(action) ? `${action} ${blockReasonTarget}` : blockReasonTarget;
			return {
				block: true,
				reason: `${subject} blocked: confirmation requires UI. Do not attempt another mutation method. Ask the user why it was blocked.`,
			};
		}

		const preview = await buildPreview(action, input, ctx);
		const toolDescription = getToolDescription(action, input);
		const choice = await promptForApproval(action, toolDescription, preview, ctx, {
			isEnabled: () => allowEnabled,
			toggle: () => setAllowEnabled(!allowEnabled, ctx),
		});

		if (choice.action === "allow") {
			if (choice.note) {
				pi.sendMessage(
					{
						customType: "mutation-guard-note",
						content: choice.note,
						display: true,
					},
					{ deliverAs: "steer" },
				);
			}
			return undefined;
		}

		const blockedSubject = isFileToolAction(action) ? `${action} ${blockReasonTarget}` : blockReasonTarget;
		const blockedMessage = choice.note?.trim() ?? "";
		if (choice.action === "abort") {
			ctx.abort();
			return undefined;
		}
		return {
			block: true,
			reason:
				blockedMessage.length > 0
					? `Blocked this specific tool call for ${blockedSubject}. Adjust it according to the user's note and try again if appropriate. User note: ${blockedMessage}`
					: `Blocked by user: ${blockedSubject}`,
		};
	});
}
