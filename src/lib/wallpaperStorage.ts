const DATABASE_NAME = "soniq-wallpapers";
const DATABASE_VERSION = 1;
const STORE_NAME = "files";
export const LIVE_WALLPAPER_KEY = "live-wallpaper";
export const IMAGE_WALLPAPER_KEY = "image-wallpaper";
export const LIVE_WALLPAPER_MARKER = "idb:live-wallpaper";
export const IMAGE_WALLPAPER_MARKER = "idb:image-wallpaper";
export const WALLPAPER_MARKER_PREFIX = "idb:wallpaper:";

export type WallpaperKind = "image" | "video";

export type StoredWallpaper = {
  key: string;
  blob: Blob;
  name: string;
  type: string;
  createdAt: number;
};

export function wallpaperMarker(key: string) {
  return `${WALLPAPER_MARKER_PREFIX}${key}`;
}

export function getWallpaperKey(
  marker: string | null | undefined,
): string | null {
  if (!marker) return null;
  if (marker === LIVE_WALLPAPER_MARKER) return LIVE_WALLPAPER_KEY;
  if (marker === IMAGE_WALLPAPER_MARKER) return IMAGE_WALLPAPER_KEY;
  return marker.startsWith(WALLPAPER_MARKER_PREFIX)
    ? marker.slice(WALLPAPER_MARKER_PREFIX.length)
    : null;
}

export function wallpaperKind(
  record: Pick<StoredWallpaper, "type">,
): WallpaperKind {
  return record.type.startsWith("video/") ? "video" : "image";
}

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open wallpaper storage"));
  });

async function saveWallpaperFile(
  key: string,
  file: File,
): Promise<StoredWallpaper> {
  const record: StoredWallpaper = {
    key,
    blob: file,
    name: file.name,
    type: file.type,
    createdAt: Date.now(),
  };
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not save wallpaper file"));
    });
  } finally {
    database.close();
  }
  return record;
}

async function getWallpaperRecord(
  key: string,
): Promise<StoredWallpaper | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await openDatabase();
  try {
    return await new Promise<StoredWallpaper | undefined>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(key);
      request.onsuccess = () =>
        resolve(request.result as StoredWallpaper | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read wallpaper file"));
    });
  } finally {
    database.close();
  }
}

export async function getWallpaperUrl(key: string): Promise<string | null> {
  const record = await getWallpaperRecord(key);
  return record?.blob ? URL.createObjectURL(record.blob) : null;
}

async function deleteWallpaperFile(key: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Could not remove wallpaper file"),
        );
    });
  } finally {
    database.close();
  }
}

export async function listWallpaperFiles(): Promise<StoredWallpaper[]> {
  if (typeof indexedDB === "undefined") return [];
  const database = await openDatabase();
  try {
    return await new Promise<StoredWallpaper[]>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as StoredWallpaper[]).sort(
            (a, b) => b.createdAt - a.createdAt,
          ),
        );
      request.onerror = () =>
        reject(request.error ?? new Error("Could not list wallpaper files"));
    });
  } finally {
    database.close();
  }
}

export async function saveWallpaperLibraryFile(
  file: File,
): Promise<StoredWallpaper> {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return saveWallpaperFile(`library-${suffix}`, file);
}

export const saveLiveWallpaperFile = (file: File) =>
  saveWallpaperFile(LIVE_WALLPAPER_KEY, file);
export const saveImageWallpaperFile = (file: File) =>
  saveWallpaperFile(IMAGE_WALLPAPER_KEY, file);
export const getLiveWallpaperUrl = () => getWallpaperUrl(LIVE_WALLPAPER_KEY);
export const getImageWallpaperUrl = () => getWallpaperUrl(IMAGE_WALLPAPER_KEY);
export const deleteLiveWallpaperFile = () =>
  deleteWallpaperFile(LIVE_WALLPAPER_KEY);
export const deleteImageWallpaperFile = () =>
  deleteWallpaperFile(IMAGE_WALLPAPER_KEY);
export { deleteWallpaperFile };

export async function deleteAllWallpaperFiles(): Promise<void> {
  const records = await listWallpaperFiles();
  await Promise.all(records.map((record) => deleteWallpaperFile(record.key)));
}
