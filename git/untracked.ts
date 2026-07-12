import { RepoFS } from "./gitCore";

// A pragmatic .gitignore implementation: enough to match git for the common patterns (directory
// names, extensions, anchored paths, negation, **). Not a full wildmatch, but it correctly skips the
// heavy ignored trees (node_modules, build output, …) so untracked-file discovery stays fast.

type IgnoreRule = { baseDir: string; negated: boolean; dirOnly: boolean; anchored: boolean; regex: RegExp };

function globToRegex(pattern: string): string {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
        let c = pattern[i];
        if (c === "*") {
            if (pattern[i + 1] === "*") {
                i++;
                if (pattern[i + 1] === "/") {
                    i++;
                    re += "(?:.*/)?";
                } else {
                    re += ".*";
                }
            } else {
                re += "[^/]*";
            }
        } else if (c === "?") {
            re += "[^/]";
        } else if ("\\^$.|+()[]{}".indexOf(c) >= 0) {
            re += "\\" + c;
        } else {
            re += c;
        }
    }
    return re;
}

function compileRule(line: string, baseDir: string): IgnoreRule | undefined {
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
    }
    let dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (!pattern) return undefined;
    // A slash anywhere (except the trailing one already removed) anchors the pattern to baseDir;
    // otherwise it matches by basename at any depth.
    let anchored = pattern.startsWith("/") || pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    return { baseDir, negated, dirOnly, anchored, regex: new RegExp("^" + globToRegex(pattern) + "$") };
}

async function loadRules(fs: RepoFS, dir: string): Promise<IgnoreRule[]> {
    let bytes = await fs.readFile(dir ? dir + "/.gitignore" : ".gitignore");
    if (!bytes) return [];
    let rules: IgnoreRule[] = [];
    for (let raw of new TextDecoder().decode(bytes).split("\n")) {
        let line = raw.replace(/\r$/, "").trim();
        if (!line || line.startsWith("#")) continue;
        let rule = compileRule(line, dir);
        if (rule) rules.push(rule);
    }
    return rules;
}

function isIgnored(rules: IgnoreRule[], path: string, isDir: boolean): boolean {
    let ignored = false;
    for (let rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.baseDir && !(path === rule.baseDir || path.startsWith(rule.baseDir + "/"))) continue;
        let rel = rule.baseDir ? path.slice(rule.baseDir.length + 1) : path;
        let segments = rel.split("/");
        let target = rule.anchored ? rel : segments[segments.length - 1];
        if (rule.regex.test(target)) ignored = !rule.negated;
    }
    return ignored;
}

// Working-tree files that are not in `tracked` and not ignored — i.e. `git ls-files --others --exclude-standard`.
export async function listUntracked(fs: RepoFS, tracked: Set<string>): Promise<string[]> {
    let out: string[] = [];
    async function walk(dir: string, inherited: IgnoreRule[]) {
        let entries = await fs.readDir(dir);
        if (!entries) return;
        let rules = inherited;
        if (entries.some(e => e.name === ".gitignore" && e.kind === "file")) {
            rules = inherited.concat(await loadRules(fs, dir));
        }
        let subdirs: string[] = [];
        for (let entry of entries) {
            if (entry.name === ".git") continue;
            let path = dir ? dir + "/" + entry.name : entry.name;
            let isDir = entry.kind === "directory";
            if (isIgnored(rules, path, isDir)) continue;
            if (isDir) subdirs.push(path);
            else if (!tracked.has(path)) out.push(path);
        }
        await Promise.all(subdirs.map(d => walk(d, rules)));
    }
    await walk("", []);
    return out;
}
