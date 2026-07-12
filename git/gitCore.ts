// Native git-reading primitives with no dependencies, so the identical code runs in the browser
// (backed by the File System Access API) and in Node (backed by fs, for tests).

export interface RepoFS {
    // Repo-relative, "/"-separated paths (e.g. ".git/index"). Resolves to undefined when missing.
    readFile(path: string): Promise<Uint8Array | undefined>;
    readDir(path: string): Promise<{ name: string; kind: "file" | "directory" }[] | undefined>;
    // Size and mtime without reading contents — lets status skip unchanged files like git does.
    stat(path: string): Promise<{ size: number; mtimeMs: number } | undefined>;
}

export function toHex(bytes: Uint8Array) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
}

export function readUint32BE(bytes: Uint8Array, pos: number) {
    return (bytes[pos] * 0x1000000 + (bytes[pos + 1] << 16) + (bytes[pos + 2] << 8) + bytes[pos + 3]);
}

export async function sha1Hex(data: Uint8Array) {
    let digest = await crypto.subtle.digest("SHA-1", data);
    return toHex(new Uint8Array(digest));
}

// The object id of a file's contents: sha1 of "blob <len>\0<bytes>".
export async function hashBlob(content: Uint8Array) {
    let header = new TextEncoder().encode(`blob ${content.length}\0`);
    let full = new Uint8Array(header.length + content.length);
    full.set(header, 0);
    full.set(content, header.length);
    return await sha1Hex(full);
}

// Inflate a complete zlib stream. Loose objects are exactly one stream, so this is safe for them.
export async function inflateAll(bytes: Uint8Array) {
    let ds = new DecompressionStream("deflate");
    let out = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
}

// Inflate only until `size` bytes are produced, then cancel. Required inside packfiles, where each
// zlib stream is immediately followed by more pack data (feeding that to DecompressionStream throws
// "trailing junk"). The pack object header gives us `size` before we start.
export async function inflateExact(bytes: Uint8Array, size: number) {
    let ds = new DecompressionStream("deflate");
    let reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
    let out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
        let chunk = await reader.read();
        if (chunk.done) break;
        let value = chunk.value;
        let take = Math.min(value.length, size - filled);
        out.set(value.subarray(0, take), filled);
        filled += take;
    }
    await reader.cancel().catch(() => undefined);
    if (filled !== size) {
        throw new Error(`Inflated ${filled} bytes but expected ${size}`);
    }
    return out;
}
