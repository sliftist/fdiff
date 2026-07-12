import * as fs from "fs";
import * as nodePath from "path";
import { RepoFS } from "./gitCore";

// Node-backed RepoFS, used only for tests — it lets the exact browser code run against a real repo
// so we can diff its output against `git` itself.
export function nodeRepoFS(root: string): RepoFS {
    return {
        async readFile(path) {
            try {
                return new Uint8Array(await fs.promises.readFile(nodePath.join(root, path)));
            } catch {
                return undefined;
            }
        },
        async readDir(path) {
            try {
                let entries = await fs.promises.readdir(nodePath.join(root, path), { withFileTypes: true });
                return entries.map(e => ({ name: e.name, kind: e.isDirectory() ? "directory" as const : "file" as const }));
            } catch {
                return undefined;
            }
        },
        async stat(path) {
            try {
                let st = await fs.promises.stat(nodePath.join(root, path));
                return { size: st.size, mtimeMs: st.mtimeMs };
            } catch {
                return undefined;
            }
        },
    };
}
