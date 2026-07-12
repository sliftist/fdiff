import { RepoFS } from "./gitCore";

// RepoFS backed by a File System Access API directory handle (the repo root the user granted). The
// git core reads repo-relative paths like ".git/index"; we walk the handle tree to resolve them.
// Directory handles are cached, since re-resolving each path segment from the root is the API's main
// cost when touching thousands of files.
export function fsAccessRepoFS(root: FileSystemDirectoryHandle): RepoFS {
    let dirCache = new Map<string, Promise<FileSystemDirectoryHandle | undefined>>();
    dirCache.set("", Promise.resolve(root));

    function getDir(parts: string[]): Promise<FileSystemDirectoryHandle | undefined> {
        let key = parts.join("/");
        let cached = dirCache.get(key);
        if (cached) return cached;
        let promise = (async () => {
            let parent = await getDir(parts.slice(0, -1));
            if (!parent) return undefined;
            try {
                return await parent.getDirectoryHandle(parts[parts.length - 1]);
            } catch {
                return undefined;
            }
        })();
        dirCache.set(key, promise);
        return promise;
    }

    async function getFileHandle(path: string) {
        let parts = path.split("/").filter(Boolean);
        let fileName = parts.pop();
        if (!fileName) return undefined;
        let dir = await getDir(parts);
        if (!dir) return undefined;
        try {
            return await dir.getFileHandle(fileName);
        } catch {
            return undefined;
        }
    }

    return {
        async readFile(path) {
            let handle = await getFileHandle(path);
            if (!handle) return undefined;
            let file = await handle.getFile();
            return new Uint8Array(await file.arrayBuffer());
        },
        async stat(path) {
            let handle = await getFileHandle(path);
            if (!handle) return undefined;
            let file = await handle.getFile();
            return { size: file.size, mtimeMs: file.lastModified };
        },
        async readDir(path) {
            let dir = await getDir(path.split("/").filter(Boolean));
            if (!dir) return undefined;
            let out: { name: string; kind: "file" | "directory" }[] = [];
            for await (let [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
                out.push({ name, kind: handle.kind });
            }
            return out;
        },
    };
}
