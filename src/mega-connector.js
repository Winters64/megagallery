import { Storage } from "megajs";

const dialog = document.querySelector("#mega-dialog");
const form = document.querySelector("#mega-login-form");
const submitButton = document.querySelector("#mega-submit");
const errorOutput = document.querySelector("#mega-error");
let storage = null;
let filesById = new Map();
let folderNodesByPath = new Map();
let cacheKeysByFile = new WeakMap();

const imageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"]);
const videoExtensions = new Set(["mp4", "m4v", "mov", "webm", "avi", "mkv", "ogv", "3gp", "mpg", "mpeg", "mts", "m2ts", "ts", "wmv", "flv"]);
const imageThumbnailLimit = 12 * 1024 * 1024;
const gifThumbnailLimit = 30 * 1024 * 1024;
const videoThumbnailLimit = 100 * 1024 * 1024;
const photoPreviewLimit = 30 * 1024 * 1024;
const videoPreviewLimit = 100 * 1024 * 1024;
const legacyCacheDatabaseName = "mega-gallery-preview-cache";
const sessionPreviewCacheLimit = 96 * 1024 * 1024;
const sessionFullPhotoCacheLimit = 90 * 1024 * 1024;
const maxMegaAttributeConcurrency = 6;
const maxFallbackThumbnailConcurrency = 2;
const sessionStorageKey = "mega-gallery-session";
const mediaTagsAttribute = "t";
const maxMediaTagCount = 10;
const maxMediaTagsBytes = 3000;
const sessionPreviewCache = new Map();
let sessionPreviewCacheBytes = 0;
const sessionFullPhotoCache = new Map();
let sessionFullPhotoCacheBytes = 0;
const fullPhotoRequests = new Map();
const thumbnailRequests = new Map();
const previewBlobRequests = new Map();
const megaAttributeQueue = [];
const fallbackThumbnailQueue = [];
let activeMegaAttributeDownloads = 0;
let activeFallbackThumbnailDownloads = 0;
let preloadObserver = null;
let visibilityObserver = null;
let observerScrollRoot = null;
let thumbnailGeneration = 0;
let preferredUfaSuffixMode = null;
let activeRefreshPromise = null;
let liveSyncTimer = null;

function purgeLegacyLocalCache() {
  if (!("indexedDB" in window)) return;
  try {
    indexedDB.deleteDatabase(legacyCacheDatabaseName);
  } catch (error) {
    console.warn("Impossible de supprimer l’ancien cache local.", error);
  }
}
const escapeAttribute = (value) => String(value).replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));

function readMediaTags(value) {
  if (typeof value !== "string") return [];
  const tags = [];
  const seen = new Set();
  for (const entry of value.split(",")) {
    const tag = entry.trim().replace(/\s+/g, " ");
    const normalized = tag.toLocaleLowerCase("fr");
    if (!tag || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(tag);
    if (tags.length === maxMediaTagCount) break;
  }
  return tags;
}

function normalizeMediaTags(value) {
  if (!Array.isArray(value)) throw new Error("La liste des tags est invalide.");
  const tags = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Chaque tag doit être du texte.");
    const tag = entry.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.includes(",")) throw new Error("Un tag ne peut pas contenir de virgule.");
    const normalized = tag.toLocaleLowerCase("fr");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(tag);
  }
  if (tags.length > maxMediaTagCount) {
    throw new Error(`Un média peut avoir au maximum ${maxMediaTagCount} tags.`);
  }
  if (new TextEncoder().encode(tags.join(",")).length > maxMediaTagsBytes) {
    throw new Error(`La liste des tags dépasse la limite de ${maxMediaTagsBytes} octets de MEGA.`);
  }
  return tags;
}

function getExtension(name) {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLocaleLowerCase("en");
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} ${units[unitIndex]}`;
}

function getWebCryptoError() {
  if (window.isSecureContext && typeof globalThis.crypto?.subtle?.importKey === "function") return "";
  return "La connexion MEGA nécessite Web Crypto dans un contexte sécurisé (HTTPS ou localhost). Cette adresse est en HTTP : n’y saisissez pas vos identifiants.";
}

function formatDate(node) {
  const seconds = getTimestamp(node);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const date = new Date(seconds * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTimestamp(node) {
  if (Number.isFinite(Number(node?.timestamp)) && Number(node.timestamp) > 0) {
    return Number(node.timestamp);
  }
  if (Number.isFinite(Number(node?.createdAt)) && Number(node.createdAt) > 0) {
    return Math.floor(Number(node.createdAt) / 1000);
  }
  return 0;
}

function getMimeType(name, type) {
  const extension = getExtension(name);
  if (type === "video") {
    return ({
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/mp4",
      webm: "video/webm",
      ogv: "video/ogg",
      "3gp": "video/3gpp",
      mpg: "video/mpeg",
      mpeg: "video/mpeg",
      mts: "video/mp2t",
      m2ts: "video/mp2t",
      ts: "video/mp2t",
      wmv: "video/x-ms-wmv",
      flv: "video/x-flv",
      avi: "video/x-msvideo",
      mkv: "video/x-matroska"
    })[extension] || "application/octet-stream";
  }
  return ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp"
  })[extension] || "application/octet-stream";
}

function scheduleLiveLibrarySync(candidate) {
  window.clearTimeout(liveSyncTimer);
  liveSyncTimer = window.setTimeout(() => {
    liveSyncTimer = null;
    if (storage !== candidate || activeRefreshPromise) return;
    if (!window.megaGallery?.isConnected?.()) return;
    const library = buildLibrary(candidate.root, candidate.trash);
    window.megaGallery.refreshLibrary(library);
  }, 450);
}

function attachFileAttributesTracker(candidate) {
  if (!candidate || candidate.__faTrackerAttached) return candidate;
  candidate.__faTrackerAttached = true;
  const originalImportFile = candidate._importFile.bind(candidate);
  candidate._importFile = (rawNode) => {
    const file = originalImportFile(rawNode);
    if (file && rawNode && typeof rawNode === "object") {
      if (typeof rawNode.fa === "string") {
        file.fa = rawNode.fa;
      } else if (typeof file.fa !== "string") {
        file.fa = "";
      }
    }
    return file;
  };
  candidate.api.on("sc", (events) => {
    if (!Array.isArray(events)) return;
    let attributesUpdated = false;
    for (const event of events) {
      if (event?.a === "fa" && event.n && typeof event.fa === "string") {
        const target = candidate.files?.[event.n];
        if (target && target.fa !== event.fa) {
          target.fa = event.fa;
          attributesUpdated = true;
        }
      }
    }
    if (attributesUpdated) scheduleLiveLibrarySync(candidate);
  });
  for (const eventName of ["add", "update", "move", "delete"]) {
    candidate.on(eventName, () => scheduleLiveLibrarySync(candidate));
  }
  return candidate;
}

function getFileCacheKey(file) {
  if (!file) return "";
  const owner = file.storage?.user || storage?.user || "mega";
  const faToken = typeof file.fa === "string" ? file.fa : "";
  if (file.nodeId) {
    return `${owner}:${file.nodeId}:${file.size || 0}:${faToken}`;
  }
  const existing = cacheKeysByFile.get(file);
  if (existing) return existing;
  const fallbackKey = `${owner}:${file.name || ""}:${file.timestamp || 0}:${file.size || 0}:${faToken}`;
  cacheKeysByFile.set(file, fallbackKey);
  return fallbackKey;
}

function isUrlMountedInDom(url) {
  if (!url) return false;
  for (const element of document.querySelectorAll("img[src], video[src]")) {
    if (element.isConnected && element.getAttribute("src") === url) return true;
  }
  return false;
}

function getSessionPreviewEntry(file) {
  const key = getFileCacheKey(file);
  if (!key) return null;
  const entry = sessionPreviewCache.get(key);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry;
}

function storeSessionPreviewBlob(file, blob) {
  const key = getFileCacheKey(file);
  if (!key || !blob) return null;
  const existing = sessionPreviewCache.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (blob.size > sessionPreviewCacheLimit) {
    return { blob, url: URL.createObjectURL(blob), bytes: blob.size, lastUsed: Date.now(), transient: true };
  }
  if (sessionPreviewCacheBytes + blob.size > sessionPreviewCacheLimit) {
    const candidates = [...sessionPreviewCache.entries()]
      .sort((first, second) => first[1].lastUsed - second[1].lastUsed);
    for (const [candidateKey, candidate] of candidates) {
      if (sessionPreviewCacheBytes + blob.size <= sessionPreviewCacheLimit) break;
      if (isUrlMountedInDom(candidate.url)) continue;
      URL.revokeObjectURL(candidate.url);
      sessionPreviewCache.delete(candidateKey);
      sessionPreviewCacheBytes = Math.max(0, sessionPreviewCacheBytes - candidate.bytes);
    }
  }
  const entry = {
    blob,
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    lastUsed: Date.now(),
    transient: false
  };
  sessionPreviewCache.set(key, entry);
  sessionPreviewCacheBytes += blob.size;
  return entry;
}

function getSessionFullPhotoEntry(file) {
  const key = getFileCacheKey(file);
  if (!key) return null;
  const entry = sessionFullPhotoCache.get(key);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry;
}

function storeSessionFullPhotoBlob(file, blob) {
  const key = getFileCacheKey(file);
  if (!key || !blob) return null;
  const existing = sessionFullPhotoCache.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (blob.size > sessionFullPhotoCacheLimit) {
    return { blob, url: URL.createObjectURL(blob), bytes: blob.size, lastUsed: Date.now(), revokeOnClose: true };
  }
  if (sessionFullPhotoCacheBytes + blob.size > sessionFullPhotoCacheLimit) {
    const candidates = [...sessionFullPhotoCache.entries()]
      .sort((first, second) => first[1].lastUsed - second[1].lastUsed);
    for (const [candidateKey, candidate] of candidates) {
      if (sessionFullPhotoCacheBytes + blob.size <= sessionFullPhotoCacheLimit) break;
      if (isUrlMountedInDom(candidate.url)) continue;
      URL.revokeObjectURL(candidate.url);
      sessionFullPhotoCache.delete(candidateKey);
      sessionFullPhotoCacheBytes = Math.max(0, sessionFullPhotoCacheBytes - candidate.bytes);
    }
  }
  const entry = {
    blob,
    url: URL.createObjectURL(blob),
    bytes: blob.size,
    lastUsed: Date.now(),
    revokeOnClose: false
  };
  sessionFullPhotoCache.set(key, entry);
  sessionFullPhotoCacheBytes += blob.size;
  return entry;
}

function getThumbnailImagesForId(id) {
  return [...document.querySelectorAll(`#photo-grid [data-thumbnail="${id}"]`)];
}

function isThumbnailIdRelevant(id) {
  if (id == null) return true;
  const images = getThumbnailImagesForId(id);
  return images.some((img) => img.isConnected && (img.dataset.inView === "true" || img.dataset.inPreload === "true"));
}

function isThumbnailIdInViewport(id) {
  if (id == null) return false;
  const images = getThumbnailImagesForId(id);
  return images.some((img) => img.isConnected && img.dataset.inView === "true");
}

function pickNextThumbnailTask(queue) {
  while (queue.length) {
    let bestIndex = -1;
    for (let index = 0; index < queue.length; index += 1) {
      const candidate = queue[index];
      if (!candidate.alwaysRun && !isThumbnailIdRelevant(candidate.id)) {
        queue.splice(index, 1);
        if (candidate.id != null) thumbnailRequests.delete(candidate.id);
        candidate.resolve(null);
        index -= 1;
        continue;
      }
      if (candidate.highPriority || isThumbnailIdInViewport(candidate.id)) {
        bestIndex = index;
        break;
      }
      if (bestIndex < 0) bestIndex = index;
    }
    if (bestIndex >= 0) {
      return queue.splice(bestIndex, 1)[0];
    }
  }
  return null;
}

function scheduleThumbnailTask(task, { fastLane = true, id = null, highPriority = false, alwaysRun = false } = {}) {
  return new Promise((resolve, reject) => {
    const entry = { task, resolve, reject, id, highPriority, alwaysRun };
    if (fastLane) {
      megaAttributeQueue.push(entry);
      processMegaAttributeQueue();
    } else {
      fallbackThumbnailQueue.push(entry);
      processFallbackThumbnailQueue();
    }
  });
}

function processMegaAttributeQueue() {
  while (activeMegaAttributeDownloads < maxMegaAttributeConcurrency && megaAttributeQueue.length) {
    const request = pickNextThumbnailTask(megaAttributeQueue);
    if (!request) break;
    activeMegaAttributeDownloads += 1;
    request.task().then(request.resolve, request.reject).finally(() => {
      activeMegaAttributeDownloads -= 1;
      processMegaAttributeQueue();
    });
  }
}

function processFallbackThumbnailQueue() {
  while (activeFallbackThumbnailDownloads < maxFallbackThumbnailConcurrency && fallbackThumbnailQueue.length) {
    const request = pickNextThumbnailTask(fallbackThumbnailQueue);
    if (!request) break;
    activeFallbackThumbnailDownloads += 1;
    request.task().then(request.resolve, request.reject).finally(() => {
      activeFallbackThumbnailDownloads -= 1;
      processFallbackThumbnailQueue();
    });
  }
}

function showThumbnailFallback(image, message) {
  if (!image?.isConnected) return;
  const placeholder = document.createElement("div");
  placeholder.className = "remote-file-placeholder";
  placeholder.title = message;
  placeholder.setAttribute("aria-label", message);
  const icon = document.createElement("strong");
  const file = filesById.get(Number(image.dataset.thumbnail));
  const extension = file ? getExtension(file.name) : "";
  if (extension === "gif") {
    icon.textContent = "GIF";
  } else {
    const symbol = videoExtensions.has(extension) ? "video" : "photo";
    icon.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-${symbol}"></use></svg>`;
  }
  const detail = document.createElement("span");
  detail.textContent = message;
  placeholder.append(icon, detail);
  image.replaceWith(placeholder);
}

function downloadBuffer(file) {
  return file.downloadBuffer({});
}

function parseMegaAttributeHandles(attributes) {
  const handles = new Map();
  if (typeof attributes !== "string" || !attributes) return handles;
  for (const match of attributes.matchAll(/(?:^|[/:])(\d+)\*([A-Za-z0-9_-]+)/g)) {
    const type = Number(match[1]);
    const handle = match[2];
    if (Number.isInteger(type) && handle && !handles.has(type)) {
      handles.set(type, handle);
    }
  }
  return handles;
}

function fileLikelyHasMegaPreview(file) {
  if (!file) return false;
  if (typeof file.fa !== "string") return true;
  const handles = parseMegaAttributeHandles(file.fa);
  return handles.has(1) || handles.has(0);
}

function decodeMegaBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeSecureMegaUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !/(^|\.)mega\.(?:co\.nz|nz|io)$/i.test(parsed.hostname)) {
    return null;
  }
  return parsed.toString().replace(/\/+$/, "");
}

function resolveMegaAttributeUrls(location, attrType) {
  const candidates = [];
  const pushUnique = (url, mode) => {
    if (!url || candidates.some((entry) => entry.url === url)) return;
    candidates.push({ url, mode });
  };
  const addCandidate = (rawUrl, allowTypedVariant) => {
    const clean = normalizeSecureMegaUrl(rawUrl);
    if (!clean) return;
    const hasNumericSuffix = /\/\d+$/.test(new URL(clean).pathname);
    if (!allowTypedVariant || hasNumericSuffix) {
      pushUnique(clean, "direct");
      return;
    }
    const typed = `${clean}/${attrType}`;
    if (preferredUfaSuffixMode === "bare") {
      pushUnique(clean, "bare");
      pushUnique(typed, "typed");
    } else {
      pushUnique(typed, "typed");
      pushUnique(clean, "bare");
    }
  };

  if (typeof location?.p === "string") {
    addCandidate(location.p, true);
  } else if (Array.isArray(location?.p)) {
    if (typeof location.p[attrType] === "string") {
      addCandidate(location.p[attrType], false);
    }
    for (const entry of location.p) {
      if (typeof entry === "string") addCandidate(entry, true);
    }
  }
  return candidates;
}

function extractMegaAttributeRecords(payload, handle) {
  const candidates = [];
  let offset = 0;
  let parsedHeaderStream = true;
  while (offset + 12 <= payload.byteLength) {
    const recordHandle = payload.subarray(offset, offset + 8);
    const length = new DataView(
      payload.buffer,
      payload.byteOffset + offset + 8,
      4
    ).getUint32(0, true);
    if (length === 0 || length % 16 !== 0 || length > 8 * 1024 * 1024 || offset + 12 + length > payload.byteLength) {
      parsedHeaderStream = false;
      break;
    }
    offset += 12;
    if (recordHandle.every((byte, index) => byte === handle[index])) {
      candidates.push(payload.subarray(offset, offset + length));
    }
    offset += length;
  }
  if ((!parsedHeaderStream || !candidates.length) && payload.byteLength >= 16 && payload.byteLength % 16 === 0) {
    candidates.push(payload);
  }
  return candidates;
}

function unpackImagePayload(bytes) {
  if (!bytes || bytes.byteLength < 16) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let end = bytes.byteLength;
    const minSearch = Math.max(2, bytes.byteLength - 16);
    while (end > minSearch && bytes[end - 1] === 0x00) {
      end -= 1;
    }
    const trimmed = bytes[end - 2] === 0xff && bytes[end - 1] === 0xd9
      ? bytes.subarray(0, end)
      : bytes;
    return new Blob([trimmed], { type: "image/jpeg" });
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let end = bytes.byteLength;
    const minSearch = Math.max(8, bytes.byteLength - 16);
    while (end > minSearch && bytes[end - 1] === 0x00) {
      end -= 1;
    }
    return new Blob([bytes.subarray(0, end)], { type: "image/png" });
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const riffSize = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, true);
    const exactEnd = riffSize > 0 ? Math.min(bytes.byteLength, riffSize + 8) : bytes.byteLength;
    return new Blob([bytes.subarray(0, exactEnd)], { type: "image/webp" });
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return new Blob([bytes], { type: "image/gif" });
  }
  return null;
}

function decryptMegaAttributeRecord(file, encryptedSlice) {
  const aesSource = file.storage?.aes || storage?.aes;
  if (!aesSource || !file.key || file.key.length < 32) {
    throw new Error("Clé de déchiffrement MEGA indisponible.");
  }
  const BufferCtor = file.key.constructor;
  const foldedKey = BufferCtor.from(file.key.slice(0, 16));
  for (let index = 0; index < 16; index += 1) {
    foldedKey[index] ^= file.key[index + 16];
  }
  const decrypted = BufferCtor.from(encryptedSlice);
  new aesSource.constructor(foldedKey).decryptCBC(decrypted);
  return unpackImagePayload(new Uint8Array(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength));
}

async function ensureFileAttributeString(file) {
  if (typeof file.fa === "string") return file.fa;
  if (!file.nodeId) return "";
  try {
    const metadata = await file.api.request({ a: "g", n: file.nodeId });
    file.fa = typeof metadata?.fa === "string" ? metadata.fa : "";
  } catch {
    file.fa = "";
  }
  return file.fa;
}

async function withSingleRetry(operation) {
  try {
    return await operation();
  } catch (firstError) {
    await new Promise((resolve) => window.setTimeout(resolve, 320));
    return operation().catch(() => {
      throw firstError;
    });
  }
}

async function fetchSingleMegaAttribute(file, attrType, attributeHandle) {
  const handle = decodeMegaBase64Url(attributeHandle);
  if (handle.byteLength !== 8) {
    throw new Error("Identifiant de miniature MEGA invalide.");
  }

  let location = null;
  try {
    location = await withSingleRetry(() => file.api.request({
      a: "ufa",
      fah: attributeHandle,
      ssl: 2,
      r: 1
    }));
  } catch {
    location = await file.api.request({
      a: "ufa",
      fah: attributeHandle,
      ssl: 2,
      r: 1,
      v: 2
    });
  }

  const candidateUrls = resolveMegaAttributeUrls(location, attrType);
  if (!candidateUrls.length) {
    throw new Error("Adresse de miniature MEGA invalide.");
  }

  let lastError = null;
  for (const candidate of candidateUrls) {
    try {
      const response = await withSingleRetry(async () => {
        const res = await file.api.fetch(candidate.url, {
          method: "POST",
          body: handle
        });
        if (res.status >= 500 || res.status === 429) {
          throw new Error(`Serveur de miniatures MEGA occupé (${res.status}).`);
        }
        return res;
      });
      if (!response.ok) {
        lastError = new Error(`Téléchargement de la miniature MEGA impossible (${response.status}).`);
        continue;
      }
      const payload = new Uint8Array(await response.arrayBuffer());
      if (payload.byteLength < 16) {
        lastError = new Error("Miniature MEGA vide.");
        continue;
      }
      if (payload.byteLength > 8 * 1024 * 1024) {
        throw new Error("La miniature MEGA dépasse la taille maximale autorisée.");
      }
      const records = extractMegaAttributeRecords(payload, handle);
      for (const record of records) {
        const blob = decryptMegaAttributeRecord(file, record);
        if (blob) {
          if (candidate.mode === "typed" || candidate.mode === "bare") {
            preferredUfaSuffixMode = candidate.mode;
          }
          return blob;
        }
      }
      lastError = new Error("Données de miniature MEGA non reconnues.");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Miniature MEGA introuvable.");
}

async function createMegaAttributeThumbnail(file, preferredTypes = [1, 0]) {
  if (!file?.nodeId || !file.key || file.key.length < 32) return null;
  const faString = await ensureFileAttributeString(file);
  const handles = parseMegaAttributeHandles(faString);
  if (!handles.size) return null;

  let lastError = null;
  for (const attrType of preferredTypes) {
    const attributeHandle = handles.get(attrType);
    if (!attributeHandle) continue;
    try {
      const blob = await fetchSingleMegaAttribute(file, attrType, attributeHandle);
      if (blob) return blob;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function createImageThumbnail(file) {
  const buffer = await downloadBuffer(file);
  const source = new Blob([buffer], { type: getMimeType(file.name, "photo") });
  const image = await createImageBitmap(source);
  const scale = Math.min(1, 640 / image.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    image.close();
    throw new Error("Impossible de préparer la miniature de cette image.");
  }
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Impossible de compresser la miniature de cette image."));
    }, "image/jpeg", 0.8);
  });
}

async function createOrLoadThumbnailEntry(file) {
  const cached = getSessionPreviewEntry(file);
  if (cached) return cached;

  const extension = getExtension(file.name);
  const isVideo = videoExtensions.has(extension);
  let blob = null;

  try {
    blob = await createMegaAttributeThumbnail(file, [1, 0]);
  } catch (error) {
    console.warn("Aperçu MEGA natif indisponible ; génération locale utilisée.", file.name, error);
  }

  if (!blob) {
    const isGif = extension === "gif";
    const sizeLimit = isVideo ? videoThumbnailLimit : isGif ? gifThumbnailLimit : imageThumbnailLimit;
    if (Number(file.size) > sizeLimit) {
      const limitInMb = sizeLimit / (1024 * 1024);
      throw new Error(`Aperçu MEGA absent et fichier trop volumineux (${limitInMb} Mo max).`);
    }
    blob = isVideo
      ? await createVideoThumbnail(file)
      : await createImageThumbnail(file);
  }

  return storeSessionPreviewBlob(file, blob);
}

function getOrCreateThumbnailEntry(file) {
  const cached = getSessionPreviewEntry(file);
  if (cached) return Promise.resolve(cached);
  const requestKey = getFileCacheKey(file);
  const existingRequest = previewBlobRequests.get(requestKey);
  if (existingRequest) return existingRequest;
  const request = createOrLoadThumbnailEntry(file);
  previewBlobRequests.set(requestKey, request);
  return request.finally(() => {
    if (previewBlobRequests.get(requestKey) === request) previewBlobRequests.delete(requestKey);
  });
}

function waitForMediaEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Le navigateur n’a pas pu générer l’aperçu vidéo."));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, onSuccess);
      video.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Format vidéo non pris en charge par ce navigateur."));
    };
    video.addEventListener(eventName, onSuccess, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

async function createVideoThumbnail(file) {
  const mimeType = getMimeType(file.name, "video");
  const capability = document.createElement("video").canPlayType(mimeType);
  if (!capability) throw new Error("Codec vidéo non pris en charge par ce navigateur.");

  const buffer = await downloadBuffer(file);
  const sourceUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = sourceUrl;

  try {
    await waitForMediaEvent(video, "loadedmetadata");
    if (Number.isFinite(video.duration) && video.duration > 0) {
      const seeked = waitForMediaEvent(video, "seeked");
      video.currentTime = Math.min(1, video.duration / 2);
      await seeked;
    } else {
      await waitForMediaEvent(video, "loadeddata");
    }

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("La vidéo ne contient pas d’image décodable.");
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Impossible de générer l’image d’aperçu."));
      }, "image/jpeg", 0.8);
    });
    return thumbnail;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
}

function revealImageWithUrl(image, url) {
  if (!image?.isConnected) return;
  if (image.getAttribute("src") === url) {
    if (image.complete && image.naturalWidth > 0) {
      image.classList.add("is-loaded");
    }
    return;
  }
  image.src = url;
  if (typeof image.decode === "function") {
    image.decode().then(() => {
      if (image.isConnected) image.classList.add("is-loaded");
    }).catch(() => {
      if (image.isConnected && image.complete && image.naturalWidth > 0) {
        image.classList.add("is-loaded");
      }
    });
  }
}

function applyThumbnailUrlToMatchingImages(id, url) {
  for (const currentImage of getThumbnailImagesForId(id)) {
    revealImageWithUrl(currentImage, url);
  }
}

function loadThumbnail(image) {
  const id = Number(image.dataset.thumbnail);
  const file = filesById.get(id);
  if (!file) return;

  const cachedEntry = getSessionPreviewEntry(file);
  if (cachedEntry) {
    revealImageWithUrl(image, cachedEntry.url);
    return;
  }

  if (thumbnailRequests.has(id)) return;
  const generation = thumbnailGeneration;
  const fastLane = fileLikelyHasMegaPreview(file);
  const request = scheduleThumbnailTask(async () => {
    if (generation !== thumbnailGeneration) return null;
    return getOrCreateThumbnailEntry(file);
  }, {
    fastLane,
    id,
    highPriority: image.dataset.inView === "true"
  });

  thumbnailRequests.set(id, request);
  request.then((entry) => {
    if (!entry || generation !== thumbnailGeneration) return;
    applyThumbnailUrlToMatchingImages(id, entry.url);
  }).catch((error) => {
    if (generation !== thumbnailGeneration) return;
    const message = error instanceof Error && error.message
      ? error.message
      : "Miniature MEGA indisponible.";
    for (const currentImage of getThumbnailImagesForId(id)) {
      showThumbnailFallback(currentImage, message);
    }
    console.warn("Impossible de charger la miniature MEGA.", file.name, error);
  }).finally(() => {
    if (thumbnailRequests.get(id) === request) thumbnailRequests.delete(id);
  });
}

function ensureThumbnailObservers() {
  if (!("IntersectionObserver" in window)) return;
  const scrollRoot = document.querySelector("main") || null;
  if (preloadObserver && observerScrollRoot === scrollRoot) return;
  if (preloadObserver) preloadObserver.disconnect();
  if (visibilityObserver) visibilityObserver.disconnect();
  observerScrollRoot = scrollRoot;

  visibilityObserver = new IntersectionObserver((entries) => {
    let gainedVisibility = false;
    for (const entry of entries) {
      const image = entry.target;
      if (!image.isConnected) continue;
      image.dataset.inView = String(entry.isIntersecting);
      if (entry.isIntersecting) {
        image.dataset.inPreload = "true";
        loadThumbnail(image);
        gainedVisibility = true;
      }
    }
    if (gainedVisibility) {
      processMegaAttributeQueue();
      processFallbackThumbnailQueue();
    }
  }, { root: scrollRoot, rootMargin: "60px 0px", threshold: 0 });

  preloadObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const image = entry.target;
      if (!image.isConnected) continue;
      image.dataset.inPreload = String(entry.isIntersecting);
      if (entry.isIntersecting) {
        loadThumbnail(image);
      }
    }
  }, { root: scrollRoot, rootMargin: "650px 0px", threshold: 0 });
}

function observeThumbnails(root) {
  ensureThumbnailObservers();
  if (preloadObserver) preloadObserver.disconnect();
  if (visibilityObserver) visibilityObserver.disconnect();

  const images = root.querySelectorAll("[data-thumbnail]");
  for (const image of images) {
    const id = Number(image.dataset.thumbnail);
    const file = filesById.get(id);
    if (image.dataset.loadingBound !== "true") {
      image.dataset.loadingBound = "true";
      image.addEventListener("load", () => {
        if (image.isConnected) image.classList.add("is-loaded");
      });
      image.addEventListener("error", () => {
        if (image.isConnected && (image.dataset.inView === "true" || image.dataset.inPreload === "true")) {
          showThumbnailFallback(image, "Impossible d’afficher cette miniature.");
        }
      });
    }

    const cachedEntry = file ? getSessionPreviewEntry(file) : null;
    if (cachedEntry) {
      revealImageWithUrl(image, cachedEntry.url);
      continue;
    }

    if (preloadObserver && visibilityObserver) {
      visibilityObserver.observe(image);
      preloadObserver.observe(image);
    } else {
      image.dataset.inView = "true";
      image.dataset.inPreload = "true";
      loadThumbnail(image);
    }
  }
}

function resetActiveThumbnailTasks() {
  thumbnailGeneration += 1;
  if (preloadObserver) preloadObserver.disconnect();
  if (visibilityObserver) visibilityObserver.disconnect();
  while (megaAttributeQueue.length) {
    megaAttributeQueue.shift().resolve(null);
  }
  while (fallbackThumbnailQueue.length) {
    fallbackThumbnailQueue.shift().resolve(null);
  }
  thumbnailRequests.clear();
}

function releaseAllThumbnails() {
  resetActiveThumbnailTasks();
  for (const entry of sessionPreviewCache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  sessionPreviewCache.clear();
  sessionPreviewCacheBytes = 0;

  for (const entry of sessionFullPhotoCache.values()) {
    URL.revokeObjectURL(entry.url);
  }
  sessionFullPhotoCache.clear();
  sessionFullPhotoCacheBytes = 0;
  fullPhotoRequests.clear();
}

function isNodeInTrash(node, trashRoot = storage?.trash) {
  if (!node || !trashRoot) return false;
  let current = node;
  while (current) {
    if (current === trashRoot) return true;
    current = current.parent;
  }
  return false;
}

function buildLibrary(root, trashRoot = storage?.trash, { commit = true, ownerUser = storage?.user } = {}) {
  const folders = [];
  const files = [];
  const nextFilesById = new Map();
  const nextFolderNodesByPath = new Map([["__root__", root]]);
  if (trashRoot) nextFolderNodesByPath.set("__trash__", trashRoot);
  const nextCacheKeysByFile = new WeakMap();
  let nextFileId = 1;
  let nextFolderId = 1;

  function visit(directory, parentPath = "", parentDisplayPath = "", isTrash = false) {
    if (!directory || !directory.children) return;
    for (const node of directory.children || []) {
      const name = node.name || "Sans nom";
      if (node.directory) {
        const nodeId = node.nodeId || `folder-${nextFolderId++}`;
        const path = isTrash
          ? (parentPath ? `${parentPath}/${nodeId}` : `__trash__/${nodeId}`)
          : (parentPath ? `${parentPath}/${nodeId}` : nodeId);
        const folderParent = isTrash
          ? (parentPath || "__trash__")
          : parentPath;
        const displayPath = parentDisplayPath ? `${parentDisplayPath}/${name}` : name;
        folders.push({
          path,
          parentPath: folderParent,
          name,
          displayPath,
          color: isTrash ? "#f3e8e8" : "#e9f1e6",
          emoji: isTrash ? "🗑" : "▰",
          trashed: isTrash
        });
        nextFolderNodesByPath.set(path, node);
        visit(node, path, displayPath, isTrash);
        continue;
      }

      const extension = getExtension(name);
      const type = imageExtensions.has(extension) ? "photo" : videoExtensions.has(extension) ? "video" : null;
      if (!type) continue;

      const id = nextFileId++;
      const cacheKey = ownerUser && node.nodeId
        ? `${ownerUser}:${node.nodeId}:${node.size || 0}`
        : null;
      const record = {
        id,
        fileKey: String(node.nodeId || id),
        title: name,
        folder: parentDisplayPath || (isTrash ? "Corbeille" : "Mon drive"),
        folderPath: isTrash ? (parentPath || "__trash__") : parentPath,
        timestamp: getTimestamp(node),
        date: formatDate(node),
        size: formatSize(Number(node.size)),
        type,
        favorite: Boolean(node.favorited),
        tags: readMediaTags(node.attributes?.[mediaTagsAttribute]),
        trashed: isTrash
      };
      files.push(record);
      nextFilesById.set(id, node);
      if (cacheKey) nextCacheKeysByFile.set(node, cacheKey);
    }
  }

  visit(root, "", "", false);
  if (trashRoot) {
    visit(trashRoot, "", "", true);
  }
  if (commit) {
    filesById = nextFilesById;
    folderNodesByPath = nextFolderNodesByPath;
    cacheKeysByFile = nextCacheKeysByFile;
  }
  return { files, folders };
}

function closeStorage() {
  window.clearTimeout(liveSyncTimer);
  liveSyncTimer = null;
  const previousStorage = storage;
  storage = null;
  filesById.clear();
  folderNodesByPath.clear();
  if (previousStorage) {
    previousStorage.close().catch((error) => {
      console.error("La session MEGA n’a pas pu être fermée proprement.", error);
    });
  }
}

function decodeUtf8MegaAttribute(rawValue) {
  if (typeof rawValue !== "string") return "";
  const trimmedRaw = rawValue.trim();
  if (!trimmedRaw) return "";
  try {
    const bytes = decodeMegaBase64Url(trimmedRaw);
    let end = bytes.byteLength;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    if (end === 0) return "";
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)).trim();
    if (decoded && !/[\u0000-\u001f\u007f]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // Ignore invalid base64 or non-UTF-8 payloads
  }
  return "";
}

async function fetchMegaUserAttribute(candidate, attrName) {
  if (!candidate?.user) return "";
  try {
    const res = await candidate.api.request({
      a: "uga",
      u: candidate.user,
      ua: attrName,
      v: 1
    });
    if (typeof res?.av === "string") return decodeUtf8MegaAttribute(res.av);
    if (Array.isArray(res?.av) && typeof res.av[0] === "string") return decodeUtf8MegaAttribute(res.av[0]);
    if (typeof res?.[attrName] === "string") return decodeUtf8MegaAttribute(res[attrName]);
    if (Array.isArray(res) && typeof res[0] === "string") return decodeUtf8MegaAttribute(res[0]);
    if (typeof res === "string") return decodeUtf8MegaAttribute(res);
  } catch {
    // Attribute may not exist on the account (-9 ENOENT)
  }
  return "";
}

async function resolveMegaAccountProfile(candidate) {
  if (!candidate || candidate.api?.closed) return null;
  let ugInfo = null;
  if (!candidate.user || !candidate.email || !candidate.name) {
    try {
      ugInfo = await candidate.api.request({ a: "ug" });
      if (ugInfo?.u && !candidate.user) candidate.user = ugInfo.u;
      if (typeof ugInfo?.email === "string" && ugInfo.email && !candidate.email) {
        candidate.email = ugInfo.email;
      }
    } catch {
      // Non-blocking if ug fails
    }
  }

  const [fetchedFirst, fetchedLast] = await Promise.all([
    fetchMegaUserAttribute(candidate, "*firstname"),
    fetchMegaUserAttribute(candidate, "*lastname")
  ]);

  const firstName = fetchedFirst || (typeof candidate.firstName === "string" ? candidate.firstName.trim() : "");
  const lastName = fetchedLast || (typeof candidate.lastName === "string" ? candidate.lastName.trim() : "");
  const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const legacyName = typeof ugInfo?.name === "string" && ugInfo.name.trim()
    ? ugInfo.name.trim()
    : typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : "";

  const fullName = combinedName || legacyName;
  if (fullName) candidate.name = fullName;
  candidate.firstName = firstName;
  candidate.lastName = lastName;

  return {
    firstName,
    lastName,
    accountName: fullName,
    accountEmail: candidate.email || ""
  };
}

function saveMegaSession(candidate) {
  const { key, sid, name, user } = candidate.toJSON();
  sessionStorage.setItem(sessionStorageKey, JSON.stringify({
    key,
    sid,
    name: candidate.name || name || "",
    firstName: candidate.firstName || "",
    lastName: candidate.lastName || "",
    user,
    email: candidate.email
  }));
}

function forgetMegaSession() {
  sessionStorage.removeItem(sessionStorageKey);
}

function displayConnectedLibrary(candidate) {
  storage = candidate;
  const library = buildLibrary(storage.root, storage.trash);
  window.megaGallery.setLibrary({
    ...library,
    firstName: storage.firstName || "",
    lastName: storage.lastName || "",
    accountName: storage.name || "",
    accountEmail: storage.email || ""
  });
  if (dialog.open) dialog.close();
  resolveMegaAccountProfile(candidate).then((profile) => {
    if (!profile || storage !== candidate) return;
    window.megaGallery.setProfile?.(profile);
    try {
      saveMegaSession(candidate);
    } catch {}
  }).catch(() => {});
}

function openLoginPage() {
  dialog.classList.add("login-page");
  if (!dialog.open) dialog.showModal();
  document.querySelector("#mega-email").focus();
}

function closeStorageLocally(candidate) {
  candidate.status = "closed";
  // Storage.close() also logs out the shared MEGA SID used by the replacement session.
  candidate.api.close();
}

async function performMegaLibraryRefresh(isSynchronized = null) {
  window.clearTimeout(liveSyncTimer);
  liveSyncTimer = null;
  const previousStorage = storage;
  if (!previousStorage) throw new Error("Connectez-vous à MEGA pour actualiser la bibliothèque.");
  const { key, sid, name, user } = previousStorage.toJSON();
  let candidate;
  try {
    candidate = attachFileAttributesTracker(Storage.fromJSON({
      key,
      sid,
      name,
      user,
      options: { email: previousStorage.email, keepalive: true }
    }));
    candidate.firstName = previousStorage.firstName || "";
    candidate.lastName = previousStorage.lastName || "";
    await candidate.ready;
    candidate.status = "connecting";
    await candidate.reload(true);
    candidate.status = "ready";
  } catch (error) {
    if (candidate) closeStorageLocally(candidate);
    throw new Error(`Impossible de vérifier les changements dans MEGA : ${error instanceof Error ? error.message : "erreur inconnue"}`);
  }

  if (storage !== previousStorage) {
    closeStorageLocally(candidate);
    if (!storage) throw new Error("La session MEGA a été fermée pendant l’actualisation.");
    return buildLibrary(storage.root, storage.trash, { commit: false });
  }

  if (typeof isSynchronized === "function") {
    const candidateSnapshot = buildLibrary(candidate.root, candidate.trash, {
      commit: false,
      ownerUser: candidate.user
    });
    if (!isSynchronized(candidateSnapshot)) {
      closeStorageLocally(candidate);
      return candidateSnapshot;
    }
  }

  storage = candidate;
  closeStorageLocally(previousStorage);
  const library = buildLibrary(candidate.root, candidate.trash);
  window.megaGallery.refreshLibrary(library);
  return library;
}

function enqueueMegaLibraryRefresh(isSynchronized = null) {
  const run = activeRefreshPromise
    ? activeRefreshPromise.catch(() => {}).then(() => performMegaLibraryRefresh(isSynchronized))
    : performMegaLibraryRefresh(isSynchronized);
  activeRefreshPromise = run.finally(() => {
    if (activeRefreshPromise === run) activeRefreshPromise = null;
  });
  return run;
}

function refreshMegaLibraryFromDrive() {
  return enqueueMegaLibraryRefresh(null);
}

async function refreshMegaLibraryUntil(isSynchronized) {
  let library;
  for (const delay of [0, 350, 900, 1600]) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    library = await enqueueMegaLibraryRefresh(isSynchronized);
    if (isSynchronized(library)) return library;
  }
  return library;
}

async function refreshAfterMutation(actionLabel, isSynchronized = () => true) {
  if (!storage) throw new Error("Connectez-vous à MEGA pour actualiser la bibliothèque.");
  const optimisticLibrary = buildLibrary(storage.root, storage.trash);
  window.megaGallery.refreshLibrary(optimisticLibrary);
  try {
    const library = await refreshMegaLibraryUntil(isSynchronized);
    if (!isSynchronized(library)) {
      const alignedLibrary = buildLibrary(storage.root, storage.trash);
      window.megaGallery.refreshLibrary(alignedLibrary);
      return `L’action a été effectuée dans MEGA, mais sa synchronisation n’est pas encore confirmée. Utilisez « Synchroniser depuis MEGA » pour réessayer.`;
    }
    return null;
  } catch (error) {
    console.error(`L’action « ${actionLabel} » est effectuée, mais la bibliothèque MEGA n’a pas pu être synchronisée.`, error);
    if (storage) {
      const alignedLibrary = buildLibrary(storage.root, storage.trash);
      window.megaGallery.refreshLibrary(alignedLibrary);
    }
    return `L’action a été effectuée dans MEGA, mais la synchronisation a échoué. Utilisez « Synchroniser depuis MEGA » pour réessayer.`;
  }
}

async function restoreMegaSession() {
  openLoginPage();
  const cryptoError = getWebCryptoError();
  if (cryptoError) {
    errorOutput.textContent = cryptoError;
    return;
  }

  let savedSession;
  try {
    const serialized = sessionStorage.getItem(sessionStorageKey);
    if (!serialized) return;
    savedSession = JSON.parse(serialized);
    if (!savedSession.key || !savedSession.sid || !savedSession.email) {
      throw new Error("La session MEGA enregistrée est incomplète.");
    }
  } catch (error) {
    console.error("Impossible de lire la session MEGA enregistrée.", error);
    try { forgetMegaSession(); } catch {}
    window.megaGallery.showToast("La session MEGA enregistrée est illisible. Reconnectez-vous.");
    return;
  }

  let candidate;
  try {
    candidate = attachFileAttributesTracker(Storage.fromJSON({
      key: savedSession.key,
      sid: savedSession.sid,
      name: savedSession.name || "",
      user: savedSession.user || "",
      options: { email: savedSession.email, keepalive: true }
    }));
    candidate.firstName = savedSession.firstName || "";
    candidate.lastName = savedSession.lastName || "";
    await candidate.ready;
    candidate.status = "connecting";
    await candidate.reload(true);
    candidate.status = "ready";
    displayConnectedLibrary(candidate);
  } catch (error) {
    if (candidate) closeStorageLocally(candidate);
    const message = error instanceof Error ? error.message : "";
    if (/ESID|-15|ENOENT|-9/i.test(message)) {
      try { forgetMegaSession(); } catch {}
      window.megaGallery.showToast("Session MEGA expirée. Reconnectez-vous.");
    } else {
      window.megaGallery.showToast("Session MEGA indisponible. Vérifiez votre connexion puis reconnectez-vous.");
    }
    console.error("Échec de la restauration de la session MEGA.", error);
  }
}

document.querySelector("#mega-connect").addEventListener("click", () => {
  if (window.megaGallery.isConnected()) {
    closeStorage();
    try {
      forgetMegaSession();
    } catch (error) {
      console.error("Impossible d’effacer la session MEGA enregistrée.", error);
      window.megaGallery.showToast("Impossible d’effacer la session enregistrée de cet onglet.");
    }
    window.megaGallery.clearLibrary();
    openLoginPage();
    return;
  }
  const cryptoError = getWebCryptoError();
  if (cryptoError) {
    window.megaGallery.showToast(cryptoError);
    return;
  }
  form.reset();
  openLoginPage();
});

document.querySelector("#mega-cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", (event) => {
  if (!window.megaGallery.isConnected()) event.preventDefault();
});
dialog.addEventListener("close", () => {
  dialog.classList.remove("login-page");
  form.reset();
  errorOutput.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cryptoError = getWebCryptoError();
  if (cryptoError) {
    errorOutput.textContent = cryptoError;
    document.querySelector("#mega-password").value = "";
    return;
  }

  const email = document.querySelector("#mega-email").value.trim();
  const passwordInput = document.querySelector("#mega-password");
  const password = passwordInput.value;
  const secondFactorCode = document.querySelector("#mega-2fa").value.trim();
  submitButton.disabled = true;
  submitButton.textContent = "Connexion…";
  errorOutput.textContent = "";
  let candidate;

  try {
    candidate = attachFileAttributesTracker(new Storage({
      email,
      password,
      ...(secondFactorCode ? { secondFactorCode } : {})
    }));
    await candidate.ready;
    displayConnectedLibrary(candidate);
    try {
      saveMegaSession(candidate);
    } catch (error) {
      console.error("Impossible d’enregistrer la session MEGA pour cet onglet.", error);
      window.megaGallery.showToast("Connexion réussie, mais la session ne survivra pas à un rafraîchissement.");
    }
    passwordInput.value = "";
    document.querySelector("#mega-2fa").value = "";
    dialog.close();
  } catch (error) {
    if (candidate && candidate !== storage) {
      candidate.close().catch((closeError) => {
        console.error("La session MEGA temporaire n’a pas pu être fermée.", closeError);
      });
    }
    errorOutput.textContent = error instanceof Error ? error.message : "Connexion à MEGA impossible.";
    console.error("Échec de la connexion MEGA.", error);
  } finally {
    passwordInput.value = "";
    submitButton.disabled = false;
    submitButton.textContent = "Connexion à MEGA";
  }
});

window.megaConnector = {
  observeThumbnails,
  releaseAllThumbnails,
  syncLibraryThumbnails: resetActiveThumbnailTasks,
  refreshFromMega: refreshMegaLibraryFromDrive,
  getImmediatePreviewUrl(id) {
    const file = filesById.get(Number(id));
    if (!file) return null;
    const fullEntry = getSessionFullPhotoEntry(file);
    if (fullEntry) return { url: fullEntry.url, fullQuality: true };
    const previewEntry = getSessionPreviewEntry(file);
    if (previewEntry) return { url: previewEntry.url, fullQuality: false };
    return null;
  },
  async loadQuickPreviewUrl(id) {
    const file = filesById.get(Number(id));
    if (!file || videoExtensions.has(getExtension(file.name))) return null;
    const immediate = this.getImmediatePreviewUrl(id);
    if (immediate) return immediate.url;
    try {
      const entry = await scheduleThumbnailTask(
        () => getOrCreateThumbnailEntry(file),
        { fastLane: true, highPriority: true, alwaysRun: true }
      );
      return entry?.url || null;
    } catch {
      return null;
    }
  },
  prefetchViewerItems(ids) {
    if (!Array.isArray(ids)) return;
    for (const rawId of ids.slice(0, 3)) {
      const file = filesById.get(Number(rawId));
      if (!file || videoExtensions.has(getExtension(file.name))) continue;
      if (getSessionFullPhotoEntry(file) || getSessionPreviewEntry(file)) continue;
      scheduleThumbnailTask(
        () => getOrCreateThumbnailEntry(file),
        { fastLane: fileLikelyHasMegaPreview(file), alwaysRun: true }
      ).catch(() => {});
    }
  },
  async renameFile(id, name) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de renommer un média.");
    const file = filesById.get(Number(id));
    if (!file) throw new Error("Ce média n’est plus disponible dans la session MEGA.");
    const newName = typeof name === "string" ? name.trim() : "";
    if (!newName || newName === "." || newName === ".." || /[/\\]/.test(newName)) {
      throw new Error("Saisissez un nom de fichier valide, sans barre oblique.");
    }
    if ((file.parent?.children || []).some((sibling) =>
      sibling !== file && sibling.name?.toLocaleLowerCase("fr") === newName.toLocaleLowerCase("fr")
    )) {
      throw new Error("Un élément portant ce nom existe déjà dans ce dossier.");
    }
    await file.rename(newName);
    const syncedLibrary = await refreshMegaLibraryUntil((library) =>
      library.files.some((entry) => entry.fileKey === String(file.nodeId) && entry.title === newName)
    );
    const refreshedFile = storage.files[String(file.nodeId)];
    if (!refreshedFile || refreshedFile.name !== newName) {
      throw new Error("Le renommage a été envoyé, mais le nouveau nom n’a pas été confirmé par MEGA.");
    }
    if (!syncedLibrary?.files?.some((entry) => entry.fileKey === String(file.nodeId) && entry.title === newName)) {
      window.megaGallery.refreshLibrary(buildLibrary(storage.root, storage.trash));
    }
    return newName;
  },
  async renameFolder(path, name) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de renommer un dossier.");
    const folder = folderNodesByPath.get(String(path));
    if (!folder?.directory || folder === storage.root) throw new Error("Ce dossier n’existe plus dans MEGA.");
    const newName = typeof name === "string" ? name.trim() : "";
    if (!newName || newName === "." || newName === ".." || /[/\\]/.test(newName)) {
      throw new Error("Saisissez un nom de dossier valide, sans barre oblique.");
    }
    if ((folder.parent?.children || []).some((sibling) =>
      sibling !== folder && sibling.directory && sibling.name?.toLocaleLowerCase("fr") === newName.toLocaleLowerCase("fr")
    )) {
      throw new Error("Un dossier portant ce nom existe déjà à cet emplacement.");
    }
    await folder.rename(newName);
    const library = await refreshMegaLibraryUntil((currentLibrary) =>
      currentLibrary.folders.some((entry) => entry.path === String(path) && entry.name === newName)
    );
    const refreshedFolder = storage.files[String(folder.nodeId)];
    if (!refreshedFolder || refreshedFolder.name !== newName) {
      throw new Error("Le renommage a été envoyé, mais le nouveau nom n’a pas été confirmé par MEGA.");
    }
    if (!library?.folders?.some((entry) => entry.path === String(path) && entry.name === newName)) {
      window.megaGallery.refreshLibrary(buildLibrary(storage.root, storage.trash));
    }
    return newName;
  },
  async deleteFolder(path) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de supprimer un dossier.");
    const folder = folderNodesByPath.get(String(path));
    if (!folder?.directory || folder === storage.root || folder === storage.trash) {
      throw new Error("Ce dossier n’existe plus dans MEGA.");
    }
    const folderName = folder.name;
    const folderNodeId = String(folder.nodeId);
    const previousParent = folder.parent;
    const inTrash = isNodeInTrash(folder, storage.trash);
    await folder.delete(inTrash);
    if (previousParent?.children) {
      let idx;
      while ((idx = previousParent.children.indexOf(folder)) >= 0) {
        previousParent.children.splice(idx, 1);
      }
    }
    if (inTrash) {
      folder.parent = { children: [] };
    } else {
      if (storage.trash?.children && !storage.trash.children.includes(folder)) {
        storage.trash.children.push(folder);
      }
      folder.parent = storage.trash;
    }
    const refreshWarning = await refreshAfterMutation("suppression de dossier", (currentLibrary) =>
      inTrash
        ? !currentLibrary.folders.some((entry) => entry.path.endsWith(folderNodeId))
        : currentLibrary.folders.some((entry) => entry.trashed && entry.path === `__trash__/${folderNodeId}`)
    );
    return { name: folderName, permanentlyDeleted: inTrash, refreshWarning };
  },
  async restoreFolder(path) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de restaurer un dossier.");
    const folder = folderNodesByPath.get(String(path));
    if (!folder?.directory || !isNodeInTrash(folder, storage.trash)) {
      throw new Error("Ce dossier n’est plus dans la corbeille MEGA.");
    }
    const targetRoot = storage.root;
    if ((targetRoot.children || []).some((sibling) =>
      sibling !== folder && sibling.directory && sibling.name?.toLocaleLowerCase("fr") === folder.name?.toLocaleLowerCase("fr")
    )) {
      throw new Error(`Un dossier nommé « ${folder.name} » existe déjà à la racine de Mon Drive.`);
    }
    const previousParent = folder.parent;
    const folderNodeId = String(folder.nodeId);
    await folder.moveTo(targetRoot);
    if (previousParent?.children) {
      let idx;
      while ((idx = previousParent.children.indexOf(folder)) >= 0) {
        previousParent.children.splice(idx, 1);
      }
    }
    if (!targetRoot.children.includes(folder)) targetRoot.children.push(folder);
    folder.parent = targetRoot;
    const refreshWarning = await refreshAfterMutation("restauration de dossier", (currentLibrary) =>
      currentLibrary.folders.some((entry) => !entry.trashed && entry.path === folderNodeId)
    );
    return { name: folder.name, path: folderNodeId, refreshWarning };
  },
  async createFolder(parentPath, name) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de créer un dossier.");
    const folderName = typeof name === "string" ? name.trim() : "";
    if (!folderName || folderName === "." || folderName === ".." || /[/\\]/.test(folderName)) {
      throw new Error("Saisissez un nom de dossier valide, sans barre oblique.");
    }
    const parent = folderNodesByPath.get(String(parentPath));
    if (!parent?.directory) throw new Error("Le dossier parent n’existe plus dans MEGA.");
    if ((parent.children || []).some((child) =>
      child.directory && child.name?.toLocaleLowerCase("fr") === folderName.toLocaleLowerCase("fr")
    )) {
      throw new Error("Un dossier portant ce nom existe déjà à cet emplacement.");
    }

    const folder = await parent.mkdir({ name: folderName });
    if (!folder?.directory) throw new Error("MEGA n’a pas confirmé la création du dossier.");
    if (!parent.children.includes(folder)) parent.children.push(folder);
    folder.parent = parent;
    const expectedParentPath = parentPath === "__root__" ? "" : String(parentPath);
    const library = await refreshMegaLibraryUntil((currentLibrary) =>
      currentLibrary.folders.some((entry) =>
        entry.parentPath === expectedParentPath && entry.name === folderName
      )
    );
    const created = library.folders.find((entry) =>
      entry.parentPath === expectedParentPath && entry.name === folderName
    );
    if (!created) throw new Error("Le dossier a été créé dans MEGA, mais il n’a pas pu être rechargé dans l’arborescence. Utilisez « Synchroniser depuis MEGA » pour réessayer.");
    return created;
  },
  async uploadFiles(parentPath, browserFiles, onProgress = () => {}) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant d’envoyer des fichiers.");
    const parent = folderNodesByPath.get(String(parentPath));
    if (!parent?.directory) throw new Error("Le dossier de destination n’existe plus dans MEGA.");
    if (!Array.isArray(browserFiles) || !browserFiles.length) {
      throw new Error("Sélectionnez au moins un fichier à envoyer.");
    }

    const uploaded = [];
    const failed = [];
    const namesInFolder = new Set((parent.children || []).map((child) =>
      child.name?.toLocaleLowerCase("fr")
    ));
    for (const browserFile of browserFiles) {
      const fileName = typeof browserFile?.name === "string" ? browserFile.name : "";
      if (!fileName.trim() || fileName === "." || fileName === ".." || /[/\\]/.test(fileName)) {
        failed.push({ title: browserFile?.name || "Fichier sans nom", message: "Nom de fichier invalide." });
        continue;
      }
      const normalizedName = fileName.toLocaleLowerCase("fr");
      if (namesInFolder.has(normalizedName)) {
        failed.push({ title: fileName, message: "Un élément portant ce nom existe déjà dans ce dossier." });
        continue;
      }
      namesInFolder.add(normalizedName);

      try {
        const content = new Uint8Array(await browserFile.arrayBuffer());
        const upload = parent.upload({ name: fileName, size: browserFile.size }, content);
        upload.on("progress", ({ bytesUploaded, bytesTotal }) => {
          onProgress({
            title: fileName,
            bytesUploaded,
            bytesTotal,
            percent: bytesTotal ? Math.floor(bytesUploaded / bytesTotal * 100) : 100
          });
        });
        const uploadedFile = await upload.complete;
        if (!uploadedFile?.nodeId) throw new Error("MEGA n’a pas confirmé la réception du fichier.");
        uploaded.push({ title: fileName, nodeId: String(uploadedFile.nodeId) });
      } catch (error) {
        failed.push({
          title: fileName,
          message: error instanceof Error ? error.message : "L’envoi vers MEGA a échoué."
        });
      }
    }

    if (uploaded.length) {
      try {
        await refreshMegaLibraryUntil((library) =>
          uploaded.every((entry) => library.files.some((file) => file.fileKey === entry.nodeId))
        );
      } catch (error) {
        throw new Error(`Les fichiers ont été envoyés, mais la bibliothèque n’a pas pu être actualisée : ${error instanceof Error ? error.message : "erreur inconnue"}. Utilisez « Synchroniser depuis MEGA » pour réessayer.`);
      }
      const refreshedParent = folderNodesByPath.get(String(parentPath));
      for (const entry of uploaded) {
        if (!(refreshedParent?.children || []).some((child) => String(child.nodeId) === entry.nodeId)) {
          failed.push({ title: entry.title, message: "L’envoi a été effectué, mais le fichier n’a pas été retrouvé après actualisation. Utilisez « Synchroniser depuis MEGA » pour réessayer." });
        }
      }
    }
    return { uploaded: uploaded.filter((entry) => !failed.some((failure) => failure.title === entry.title)), failed };
  },
  async moveFiles(ids, destinationPath) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de déplacer un fichier.");
    const destination = folderNodesByPath.get(String(destinationPath));
    if (!destination?.directory) throw new Error("Le dossier de destination n’existe plus dans MEGA.");
    const files = [...new Set(ids.map((id) => Number(id)))].map((id) => {
      const file = filesById.get(id);
      if (!file) throw new Error("Un ou plusieurs fichiers ne sont plus disponibles dans la session MEGA.");
      return file;
    });
    const moved = [];
    const failed = [];

    for (const file of files) {
      if (file.parent === destination) {
        failed.push({ fileKey: String(file.nodeId), title: file.name, message: "Ce média se trouve déjà dans ce dossier." });
        continue;
      }
      const previousParent = file.parent;
      try {
        await file.moveTo(destination);
        if (previousParent && previousParent !== destination) {
          let previousIndex;
          while ((previousIndex = previousParent.children?.indexOf(file) ?? -1) >= 0) {
            previousParent.children.splice(previousIndex, 1);
          }
        }
        if (!destination.children.includes(file)) destination.children.push(file);
        file.parent = destination;
        moved.push({ fileKey: String(file.nodeId), title: file.name });
      } catch (error) {
        failed.push({
          fileKey: String(file.nodeId),
          title: file.name,
          message: error instanceof Error ? error.message : "Le déplacement MEGA a échoué."
        });
      }
    }

    const expectedFolderPath = destinationPath === "__root__" ? "" : String(destinationPath);
    const refreshWarning = moved.length ? await refreshAfterMutation("déplacement", (library) =>
      moved.every((entry) => library.files.some((file) =>
        file.fileKey === entry.fileKey && file.folderPath === expectedFolderPath
      ))
    ) : null;
    return { moved, failed, refreshWarning };
  },
  async moveFile(id, destinationPath) {
    const result = await this.moveFiles([id], destinationPath);
    if (result.failed.length) throw new Error(result.failed[0].message);
    return result;
  },
  async setFavoriteFiles(ids, favorite) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de modifier les favoris.");
    const files = [...new Set(ids.map((id) => Number(id)))].map((id) => {
      const file = filesById.get(id);
      if (!file) throw new Error("Un ou plusieurs fichiers ne sont plus disponibles dans la session MEGA.");
      return file;
    });
    const succeeded = [];
    const failed = [];

    for (const file of files) {
      const wasFavorite = Boolean(file.favorited);
      try {
        if (wasFavorite !== favorite) await file.setFavorite(favorite);
        succeeded.push({ fileKey: String(file.nodeId), title: file.name });
      } catch (error) {
        file.attributes.fav = wasFavorite ? 1 : 0;
        file.favorited = wasFavorite;
        failed.push({
          fileKey: String(file.nodeId),
          title: file.name,
          message: error instanceof Error ? error.message : "La mise à jour des favoris MEGA a échoué."
        });
      }
    }

    const refreshWarning = succeeded.length ? await refreshAfterMutation("mise à jour des favoris", (library) =>
      succeeded.every((entry) => library.files.some((file) =>
        file.fileKey === entry.fileKey && file.favorite === favorite
      ))
    ) : null;
    return { succeeded, failed, refreshWarning };
  },
  async setMediaTags(id, tags) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de modifier les tags.");
    const file = filesById.get(Number(id));
    if (!file) throw new Error("Ce média n’est plus disponible dans la session MEGA.");
    const extension = getExtension(file.name || "");
    if (!imageExtensions.has(extension) && !videoExtensions.has(extension)) {
      throw new Error("Les tags MEGA sont disponibles uniquement pour les photos et vidéos.");
    }

    const nextTags = normalizeMediaTags(tags);
    const nodeId = String(file.nodeId);
    const hadPreviousValue = Object.prototype.hasOwnProperty.call(file.attributes, mediaTagsAttribute);
    const previousValue = file.attributes[mediaTagsAttribute];
    try {
      await file.setAttributes({ [mediaTagsAttribute]: nextTags.join(",") });
    } catch (error) {
      if (hadPreviousValue) file.attributes[mediaTagsAttribute] = previousValue;
      else delete file.attributes[mediaTagsAttribute];
      file.parseAttributes(file.attributes);
      throw new Error(`Impossible d’enregistrer les tags dans MEGA : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    }

    try {
      await refreshMegaLibraryUntil((library) =>
        library.files.some((entry) =>
          entry.fileKey === nodeId && JSON.stringify(entry.tags || []) === JSON.stringify(nextTags)
        )
      );
    } catch (error) {
      throw new Error(`Les tags ont été envoyés à MEGA, mais leur relecture a échoué : ${error instanceof Error ? error.message : "erreur inconnue"}`);
    }

    const refreshedFile = [...filesById.values()].find((entry) => String(entry.nodeId) === nodeId);
    const savedTags = readMediaTags(refreshedFile?.attributes?.[mediaTagsAttribute]);
    if (!refreshedFile || JSON.stringify(savedTags) !== JSON.stringify(nextTags)) {
      throw new Error("MEGA n’a pas confirmé l’enregistrement de l’attribut natif des tags. Les tags ne sont pas affichés comme enregistrés.");
    }
    const alignedLibrary = buildLibrary(storage.root, storage.trash);
    window.megaGallery.refreshLibrary(alignedLibrary);
    return savedTags;
  },
  async updateMediaTags(ids, { add = [], remove = [] } = {}) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de modifier les tags.");
    if (!Array.isArray(ids) || !Array.isArray(add) || !Array.isArray(remove)) {
      throw new Error("La sélection ou les opérations sur les tags sont invalides.");
    }

    const files = [...new Set(ids.map((id) => Number(id)))].map((id) => {
      const file = filesById.get(id);
      if (!file) throw new Error("Un ou plusieurs médias ne sont plus disponibles dans la session MEGA.");
      const extension = getExtension(file.name || "");
      if (!imageExtensions.has(extension) && !videoExtensions.has(extension)) {
        throw new Error("Les tags MEGA sont disponibles uniquement pour les photos et vidéos.");
      }
      return file;
    });
    if (!files.length) throw new Error("Sélectionnez au moins un média.");

    const tagsToAdd = normalizeMediaTags(add);
    const tagsToRemove = normalizeMediaTags(remove);
    const additions = new Set(tagsToAdd.map((tag) => tag.toLocaleLowerCase("fr")));
    if (tagsToRemove.some((tag) => additions.has(tag.toLocaleLowerCase("fr")))) {
      throw new Error("Un tag ne peut pas être ajouté et supprimé simultanément.");
    }

    const succeeded = [];
    const failed = [];
    const changed = [];
    for (const file of files) {
      const fileKey = String(file.nodeId);
      const title = file.name;
      const currentTags = readMediaTags(file.attributes?.[mediaTagsAttribute]);
      const removals = new Set(tagsToRemove.map((tag) => tag.toLocaleLowerCase("fr")));
      const next = currentTags.filter((tag) => !removals.has(tag.toLocaleLowerCase("fr")));
      for (const tag of tagsToAdd) {
        if (!next.some((entry) => entry.toLocaleLowerCase("fr") === tag.toLocaleLowerCase("fr"))) next.push(tag);
      }

      let nextTags;
      try {
        nextTags = normalizeMediaTags(next);
      } catch (error) {
        failed.push({
          fileKey,
          title,
          message: error instanceof Error ? error.message : "La liste des tags est invalide."
        });
        continue;
      }

      succeeded.push({ fileKey, title, tags: nextTags });
      if (JSON.stringify(currentTags) === JSON.stringify(nextTags)) continue;

      const attributes = file.attributes || {};
      const hadPreviousValue = Object.prototype.hasOwnProperty.call(attributes, mediaTagsAttribute);
      const previousValue = attributes[mediaTagsAttribute];
      try {
        await file.setAttributes({ [mediaTagsAttribute]: nextTags.join(",") });
        changed.push({ fileKey, title, tags: nextTags });
      } catch (error) {
        if (hadPreviousValue) attributes[mediaTagsAttribute] = previousValue;
        else delete attributes[mediaTagsAttribute];
        file.parseAttributes(attributes);
        succeeded.pop();
        failed.push({
          fileKey,
          title,
          message: error instanceof Error ? error.message : "Impossible d’enregistrer les tags dans MEGA."
        });
      }
    }

    if (changed.length) {
      try {
        await refreshMegaLibraryUntil((library) =>
          changed.every((update) => {
            const found = library.files.find((entry) => entry.fileKey === update.fileKey);
            return Boolean(found) && JSON.stringify(found.tags || []) === JSON.stringify(update.tags);
          })
        );
      } catch (error) {
        throw new Error(`Les tags ont été envoyés à MEGA, mais leur relecture a échoué : ${error instanceof Error ? error.message : "erreur inconnue"}`);
      }

      for (const update of changed) {
        const refreshedFile = [...filesById.values()].find((entry) => String(entry.nodeId) === update.fileKey);
        const savedTags = readMediaTags(refreshedFile?.attributes?.[mediaTagsAttribute]);
        if (!refreshedFile || JSON.stringify(savedTags) !== JSON.stringify(update.tags)) {
          const successIndex = succeeded.findIndex((entry) => entry.fileKey === update.fileKey);
          if (successIndex >= 0) succeeded.splice(successIndex, 1);
          failed.push({
            fileKey: update.fileKey,
            title: update.title,
            message: "MEGA n’a pas confirmé l’enregistrement des tags de ce média."
          });
        }
      }
      const alignedLibrary = buildLibrary(storage.root, storage.trash);
      window.megaGallery.refreshLibrary(alignedLibrary);
    }

    return { succeeded, failed };
  },
  async deleteFiles(ids) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de supprimer des médias.");
    const files = [...new Set(ids.map((id) => Number(id)))].map((id) => {
      const file = filesById.get(id);
      if (!file) throw new Error("Un ou plusieurs fichiers ne sont plus disponibles dans la session MEGA.");
      return file;
    });
    const succeeded = [];
    const failed = [];

    for (const file of files) {
      const previousParent = file.parent;
      try {
        const inTrash = isNodeInTrash(file, storage.trash);
        await file.delete(inTrash);
        if (previousParent?.children) {
          let previousIndex;
          while ((previousIndex = previousParent.children.indexOf(file)) >= 0) {
            previousParent.children.splice(previousIndex, 1);
          }
        }
        if (inTrash) {
          // Keep a dummy parent array so megajs's /sc delete handler doesn't throw on null parent.
          file.parent = { children: [] };
        } else {
          if (storage.trash?.children && !storage.trash.children.includes(file)) {
            storage.trash.children.push(file);
          }
          file.parent = storage.trash;
        }
        succeeded.push({ fileKey: String(file.nodeId), title: file.name, permanentlyDeleted: inTrash });
      } catch (error) {
        failed.push({
          fileKey: String(file.nodeId),
          title: file.name,
          message: error instanceof Error ? error.message : "La suppression MEGA a échoué."
        });
      }
    }

    const refreshWarning = succeeded.length ? await refreshAfterMutation("suppression", (library) =>
      succeeded.every((entry) => {
        const file = library.files.find((candidate) => candidate.fileKey === entry.fileKey);
        return entry.permanentlyDeleted ? !file : Boolean(file?.trashed);
      })
    ) : null;
    return { succeeded, failed, refreshWarning };
  },
  async emptyTrash() {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de vider la corbeille.");
    const trash = storage.trash;
    if (!trash) throw new Error("La corbeille MEGA est introuvable.");
    const items = [...(trash.children || [])];
    if (!items.length) {
      return { count: 0 };
    }
    let count = 0;
    const errors = [];
    for (const item of items) {
      try {
        await item.delete(true);
        if (trash.children) {
          const index = trash.children.indexOf(item);
          if (index >= 0) trash.children.splice(index, 1);
        }
        item.parent = { children: [] };
        count++;
      } catch (err) {
        console.error("Échec de la suppression définitive d’un élément de la corbeille :", item.name, err);
        errors.push(item.name);
      }
    }
    const refreshWarning = count > 0
      ? await refreshAfterMutation("vidage de la corbeille", (library) =>
        errors.length > 0 || (!library.files.some((f) => f.trashed) && !library.folders.some((f) => f.trashed))
      )
      : null;
    if (errors.length) {
      throw new Error(`Certains éléments n’ont pas pu être supprimés (${errors.join(", ")}).`);
    }
    return { count, refreshWarning };
  },
  async downloadPreview(id) {
    const file = filesById.get(Number(id));
    if (!file) throw new Error("Ce fichier n’est plus disponible dans la session MEGA.");
    const isVideo = videoExtensions.has(getExtension(file.name));
    if (!isVideo) {
      const cachedFull = getSessionFullPhotoEntry(file);
      if (cachedFull) {
        return { url: cachedFull.url, revokeOnClose: false, degraded: false };
      }
    }

    const limit = isVideo ? videoPreviewLimit : photoPreviewLimit;
    if (Number(file.size) > limit) {
      if (!isVideo) {
        try {
          const previewEntry = await getOrCreateThumbnailEntry(file);
          if (previewEntry?.url) {
            return {
              url: previewEntry.url,
              revokeOnClose: Boolean(previewEntry.transient),
              degraded: true,
              notice: "Aperçu MEGA optimisé affiché (original supérieur à 30 Mo)."
            };
          }
        } catch {}
      }
      throw new Error(`Ce fichier dépasse la limite de lecture en mémoire de ${isVideo ? 100 : 30} Mo.`);
    }

    if (isVideo) {
      const video = document.createElement("video");
      if (!video.canPlayType(getMimeType(file.name, "video"))) {
        throw new Error("Ce format vidéo n’est pas pris en charge par le navigateur.");
      }
      const blob = new Blob([await downloadBuffer(file)], {
        type: getMimeType(file.name, "video")
      });
      return { url: URL.createObjectURL(blob), revokeOnClose: true, degraded: false };
    }

    const requestKey = getFileCacheKey(file);
    let request = fullPhotoRequests.get(requestKey);
    if (!request) {
      request = (async () => {
        const blob = new Blob([await downloadBuffer(file)], {
          type: getMimeType(file.name, "photo")
        });
        return storeSessionFullPhotoBlob(file, blob);
      })();
      fullPhotoRequests.set(requestKey, request);
      request.finally(() => {
        if (fullPhotoRequests.get(requestKey) === request) fullPhotoRequests.delete(requestKey);
      });
    }
    const entry = await request;
    return {
      url: entry.url,
      revokeOnClose: Boolean(entry.revokeOnClose),
      degraded: false
    };
  }
};

purgeLegacyLocalCache();
restoreMegaSession();
window.addEventListener("pagehide", () => {
  releaseAllThumbnails();
  closeStorage();
});
