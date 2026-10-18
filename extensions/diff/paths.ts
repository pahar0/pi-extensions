import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const MAX_REVIEW_PATHS = 16;

/** Small argument tokenizer: quotes group whitespace; no shell evaluation or glob expansion. */
export function reviewPaths(args: string, cwd: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: string | undefined;
  let started = false;
  const finish = () => {
    if (!started) return;
    if (!token || token.includes("\0")) throw new Error("Usage: /diff [paths...] — provide non-empty file or directory paths.");
    tokens.push(token);
    token = "";
    started = false;
  };
  for (const char of args) {
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) finish();
    else { token += char; started = true; }
  }
  if (quote) throw new Error("Usage: /diff [paths...] — close the quoted path.");
  finish();
  if (!tokens.length) return [cwd];
  if (tokens.length > MAX_REVIEW_PATHS) throw new Error(`Review at most ${MAX_REVIEW_PATHS} paths at once.`);
  return [...new Set(tokens.map((path) => {
    if (path === "~") path = homedir();
    else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    return resolve(cwd, path);
  }))];
}
