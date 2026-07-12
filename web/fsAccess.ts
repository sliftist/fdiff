import { lazy } from "socket-function/src/caching";

// FileSystemDirectoryHandle objects are structured-cloneable, so IndexedDB stores them directly
// (this is the sliftutils approach). We key by the absolute path the app was opened with, so a
// link to that path can re-acquire the same directory without re-prompting, once the browser has
// remembered the permission grant.

const storeName = "directoryHandles";

const db = lazy(async () => {
    let open = indexedDB.open("fdiff_fsAccess_2f7c1e8a", 1);
    open.addEventListener("upgradeneeded", () => {
        open.result.createObjectStore(storeName, {});
    });
    await new Promise((resolve, reject) => {
        open.addEventListener("success", resolve);
        open.addEventListener("error", reject);
    });
    return open.result;
});

async function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.addEventListener("success", () => resolve(req.result));
        req.addEventListener("error", () => reject(req.error));
    });
}

async function readHandle(path: string) {
    let store = (await db()).transaction(storeName, "readonly").objectStore(storeName);
    return await requestToPromise<FileSystemDirectoryHandle | undefined>(store.get(path));
}

async function writeHandle(path: string, handle: FileSystemDirectoryHandle) {
    let store = (await db()).transaction(storeName, "readwrite").objectStore(storeName);
    await requestToPromise(store.put(handle, path));
}

export async function forgetDirectory(path: string) {
    let store = (await db()).transaction(storeName, "readwrite").objectStore(storeName);
    await requestToPromise(store.delete(path));
}

type PermissionResult = "granted" | "denied" | "prompt";
interface PermissionableHandle {
    queryPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionResult>;
    requestPermission(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionResult>;
}
function asPermissionable(handle: FileSystemDirectoryHandle) {
    return handle as unknown as PermissionableHandle;
}

// Returns a previously-granted directory for `path` without prompting, or undefined. Safe to call
// on page load (outside a user gesture) to auto-reconnect.
export async function tryGetDirectory(config: {
    path: string;
    mode: "read" | "readwrite";
}) {
    let handle = await readHandle(config.path);
    if (!handle) return undefined;
    let state = await asPermissionable(handle).queryPermission({ mode: config.mode });
    if (state !== "granted") return undefined;
    return handle;
}

export async function hasStoredDirectory(path: string) {
    return !!await readHandle(path);
}

// Must be called from a user gesture (a click): requesting permission or showing the directory
// picker requires user activation. Reuses a stored handle for `path` when the grant is still valid,
// otherwise prompts the user to pick the directory and remembers it under `path`.
export async function acquireDirectory(config: {
    path: string;
    mode: "read" | "readwrite";
}) {
    let stored = await readHandle(config.path);
    if (stored) {
        let state = await asPermissionable(stored).queryPermission({ mode: config.mode });
        if (state !== "granted") {
            state = await asPermissionable(stored).requestPermission({ mode: config.mode });
        }
        if (state === "granted") return stored;
        // The stored handle was rejected; fall through to a fresh pick.
    }

    let showPicker = (window as unknown as {
        showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!showPicker) {
        throw new Error(`This browser has no File System Access API (window.showDirectoryPicker); expected a Chromium-based browser`);
    }

    let picked = await showPicker({ mode: config.mode });
    let state = await asPermissionable(picked).requestPermission({ mode: config.mode });
    if (state !== "granted") {
        throw new Error(`Permission for ${config.path} was not granted, was "${state}"`);
    }
    await writeHandle(config.path, picked);
    return picked;
}
