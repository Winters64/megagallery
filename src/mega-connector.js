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
const cacheDatabaseName = "mega-gallery-preview-cache";
const cacheStoreName = "previews";
const cacheMetadataStoreName = "preview-metadata";
const cacheLimit = 200 * 1024 * 1024;
const sessionStorageKey = "mega-gallery-session";
const thumbnailUrls = new Map();
const thumbnailRequests = new Map();
const previewBlobRequests = new Map();
const thumbnailQueue = [];
let activeThumbnailDownloads = 0;
let thumbnailObserver = null;
let thumbnailGeneration = 0;
let cacheDatabasePromise = null;
let cacheUnavailableReason = "";
let localCacheNotice = "";
let cachePersistent = null;
const escapeAttribute = (value) => String(value).replace(/[&<>"']/g, (char) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
));

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
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function getTimestamp(node) {
  const seconds = Number(node.timestamp || node.createdAt);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
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

function runThumbnailDownload(task) {
  return new Promise((resolve, reject) => {
    thumbnailQueue.push({ task, resolve, reject });
    processThumbnailQueue();
  });
}

function processThumbnailQueue() {
  while (activeThumbnailDownloads < 2 && thumbnailQueue.length) {
    const request = thumbnailQueue.shift();
    activeThumbnailDownloads += 1;
    request.task().then(request.resolve, request.reject).finally(() => {
      activeThumbnailDownloads -= 1;
      processThumbnailQueue();
    });
  }
}

function revokeThumbnail(id, image) {
  const url = thumbnailUrls.get(id);
  if (!url) return;
  if (image?.getAttribute("src") === url) image.removeAttribute("src");
  URL.revokeObjectURL(url);
  thumbnailUrls.delete(id);
}

function showThumbnailFallback(image, message) {
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
    }, "image/jpeg", 0.78);
  });
}

function getCacheDatabase() {
  if (cacheUnavailableReason) return Promise.reject(new Error(cacheUnavailableReason));
  if (!("indexedDB" in window)) {
    cacheUnavailableReason = "IndexedDB n’est pas disponible dans ce navigateur.";
    return Promise.reject(new Error(cacheUnavailableReason));
  }
  if (!cacheDatabasePromise) {
    cacheDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(cacheDatabaseName, 3);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(cacheStoreName)) {
          const store = database.createObjectStore(cacheStoreName, { keyPath: "key" });
          store.createIndex("lastUsed", "lastUsed");
        }
        if (!database.objectStoreNames.contains(cacheMetadataStoreName)) {
          const metadata = database.createObjectStore(cacheMetadataStoreName, { keyPath: "key" });
          const cursorRequest = request.transaction.objectStore(cacheStoreName).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value;
            metadata.put({
              key: record.key,
              bytes: record.bytes || record.blob?.size || 0,
              lastUsed: record.lastUsed || 0
            });
            cursor.continue();
          };
          cursorRequest.onerror = () => request.transaction.abort();
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        requestPersistentCache();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error("Impossible d’ouvrir IndexedDB."));
      request.onblocked = () => reject(new Error("L’ouverture du cache est bloquée par un autre onglet."));
    }).catch((error) => {
      cacheUnavailableReason = error.message || "Cache local indisponible.";
      cacheDatabasePromise = null;
      throw error;
    });
  }
  return cacheDatabasePromise;
}

async function requestPersistentCache() {
  if (!navigator.storage?.persist || !navigator.storage?.persisted) return;
  if (cachePersistent !== null) return;
  try {
    cachePersistent = await navigator.storage.persisted();
    if (!cachePersistent) cachePersistent = await navigator.storage.persist();
  } catch (error) {
    cachePersistent = false;
    console.warn("Impossible de demander une protection durable du cache local.", error);
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Erreur de lecture du cache local."));
  });
}

function transactionResult(transaction, errorMessage) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error(errorMessage));
    transaction.onabort = () => reject(transaction.error || new Error(errorMessage));
  });
}

async function getCachedBlob(key) {
  if (!key || cacheUnavailableReason) return null;
  const database = await getCacheDatabase();
  const transaction = database.transaction([cacheStoreName, cacheMetadataStoreName], "readwrite");
  const done = transactionResult(transaction, "Erreur de lecture du cache local.");
  const recordRequest = transaction.objectStore(cacheStoreName).get(key);
  const metadataRequest = transaction.objectStore(cacheMetadataStoreName).get(key);
  let record;
  let metadata;
  try {
    [record, metadata] = await Promise.all([requestResult(recordRequest), requestResult(metadataRequest)]);
  } catch (error) {
    await done.catch(() => {});
    throw error;
  }
  if (record && metadata) {
    metadata.lastUsed = Date.now();
    transaction.objectStore(cacheMetadataStoreName).put(metadata);
  }
  await done;
  return record?.blob || null;
}

async function storeCachedBlob(key, blob) {
  if (!key || !blob || blob.size > cacheLimit || cacheUnavailableReason) return false;
  const database = await getCacheDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([cacheStoreName, cacheMetadataStoreName], "readwrite");
    const done = transactionResult(transaction, "Impossible d’enregistrer le cache local.");
    const store = transaction.objectStore(cacheStoreName);
    const metadataStore = transaction.objectStore(cacheMetadataStoreName);
    let saved = false;
    const request = metadataStore.getAll();
    request.onsuccess = () => {
      const records = request.result;
      const existing = records.find((record) => record.key === key);
      let totalBytes = records.reduce((sum, record) => sum + (record.bytes || 0), 0) - (existing?.bytes || 0);
      const evictable = records.filter((record) => record.key !== key).sort((a, b) => a.lastUsed - b.lastUsed);

      while (totalBytes + blob.size > cacheLimit && evictable.length) {
        const oldest = evictable.shift();
        store.delete(oldest.key);
        metadataStore.delete(oldest.key);
        totalBytes -= oldest.bytes || 0;
      }

      if (totalBytes + blob.size > cacheLimit) return;
      store.put({ key, blob });
      metadataStore.put({ key, bytes: blob.size, lastUsed: Date.now() });
      saved = true;
    };
    request.onerror = () => reject(request.error || new Error("Impossible de préparer le cache local."));
    done.then(() => resolve(saved), reject);
  });
}

async function getCacheStats() {
  if (cacheUnavailableReason) {
    return { available: false, error: cacheUnavailableReason, bytes: 0, entries: 0, persistent: false };
  }
  await requestPersistentCache();
  const database = await getCacheDatabase();
  const transaction = database.transaction(cacheMetadataStoreName, "readonly");
  const records = await requestResult(transaction.objectStore(cacheMetadataStoreName).getAll());
  return {
    available: true,
    bytes: records.reduce((sum, record) => sum + (record.bytes || 0), 0),
    entries: records.length,
    persistent: cachePersistent === true,
    warning: localCacheNotice
  };
}

async function updateCacheStatus() {
  try {
    const stats = await getCacheStats();
    window.megaGallery.setCacheStatus(stats);
    return stats;
  } catch (error) {
    cacheUnavailableReason = error.message || "Cache local indisponible.";
    const stats = { available: false, error: cacheUnavailableReason, bytes: 0, entries: 0, persistent: false };
    window.megaGallery.setCacheStatus(stats);
    return stats;
  }
}

async function clearPersistentCache() {
  const database = await getCacheDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction([cacheStoreName, cacheMetadataStoreName], "readwrite");
    transaction.objectStore(cacheStoreName).clear();
    transaction.objectStore(cacheMetadataStoreName).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Impossible de vider IndexedDB."));
    transaction.onabort = () => reject(transaction.error || new Error("Vidage du cache annulé."));
  });
  localCacheNotice = "";
}

async function createOrLoadThumbnailBlob(file) {
  const key = cacheKeysByFile.get(file);
  const isVideo = videoExtensions.has(getExtension(file.name));
  let blob = null;
  if (key) {
    try {
      const cachedBlob = await getCachedBlob(key);
      if (cachedBlob) blob = cachedBlob;
    } catch (error) {
      localCacheNotice = "Lecture du cache local impossible ; les aperçus seront rechargés depuis MEGA.";
      console.warn("Lecture du cache des aperçus impossible ; téléchargement direct utilisé.", error);
      await updateCacheStatus();
    }
  }

  if (!blob) {
    blob = isVideo
      ? await createVideoThumbnail(file)
      : await createImageThumbnail(file);
  }

  if (key && blob) {
    try {
      const saved = await storeCachedBlob(key, blob);
      localCacheNotice = saved
        ? ""
        : "Cache local plein ; l’aperçu reste temporaire sur cet appareil.";
      await updateCacheStatus();
    } catch (error) {
      localCacheNotice = "Enregistrement local impossible ; l’aperçu reste temporaire sur cet appareil.";
      console.warn("Écriture du cache des aperçus impossible ; l’aperçu reste en mémoire.", error);
      await updateCacheStatus();
    }
  }
  return blob;
}

function getOrCreateThumbnailBlob(file) {
  const requestKey = cacheKeysByFile.get(file) || `${file.name}:${file.timestamp || 0}:${file.size || 0}`;
  const existingRequest = previewBlobRequests.get(requestKey);
  if (existingRequest) return existingRequest;
  const request = createOrLoadThumbnailBlob(file);
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
      }, "image/jpeg", 0.78);
    });
    return thumbnail;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
}

function loadThumbnail(image) {
  const id = Number(image.dataset.thumbnail);
  const existingUrl = thumbnailUrls.get(id);
  if (existingUrl) {
    image.src = existingUrl;
    return;
  }
  const pendingRequest = thumbnailRequests.get(id);
  if (pendingRequest) return;
  const file = filesById.get(id);
  if (!file) return;
  const extension = getExtension(file.name);
  const isVideo = videoExtensions.has(extension);
  const isGif = extension === "gif";
  const sizeLimit = isVideo ? videoThumbnailLimit : isGif ? gifThumbnailLimit : imageThumbnailLimit;
  if (Number(file.size) > sizeLimit) {
    const limitInMb = sizeLimit / (1024 * 1024);
    showThumbnailFallback(image, `Fichier trop volumineux pour une miniature (maximum ${limitInMb} Mo).`);
    return;
  }

  const generation = thumbnailGeneration;
  const request = runThumbnailDownload(async () => {
    if (generation !== thumbnailGeneration) return null;
    return getOrCreateThumbnailBlob(file);
  });
  thumbnailRequests.set(id, request);
  request.then((blob) => {
    if (!blob) return;
    const currentImage = document.querySelector(`#photo-grid [data-thumbnail="${id}"]`);
    if (generation !== thumbnailGeneration || !currentImage || currentImage.dataset.inView !== "true") {
      return;
    }
    const url = URL.createObjectURL(blob);
    thumbnailUrls.set(id, url);
    currentImage.src = url;
  }).catch((error) => {
    const currentImage = document.querySelector(`#photo-grid [data-thumbnail="${id}"]`);
    if (currentImage) showThumbnailFallback(currentImage, error.message || "Miniature MEGA indisponible.");
    console.warn("Impossible de charger la miniature MEGA.", error);
  }).finally(() => {
    if (thumbnailRequests.get(id) === request) thumbnailRequests.delete(id);
  });
}

function observeThumbnails(root) {
  if (!thumbnailObserver && "IntersectionObserver" in window) {
    thumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const image = entry.target;
        if (!image.isConnected) continue;
        const id = Number(image.dataset.thumbnail);
        image.dataset.inView = String(entry.isIntersecting);
        if (entry.isIntersecting) {
          loadThumbnail(image);
        }
      }
    }, { rootMargin: "100px", threshold: 0.01 });
  }

  for (const [id, url] of thumbnailUrls) {
    const image = root.querySelector(`[data-thumbnail="${id}"]`);
    if (image) image.src = url;
    else revokeThumbnail(id);
  }
  const images = root.querySelectorAll("[data-thumbnail]");
  for (const image of images) {
    if (image.dataset.loadingBound !== "true") {
      image.dataset.loadingBound = "true";
      image.addEventListener("load", () => {
        if (image.isConnected) image.classList.add("is-loaded");
      });
      image.addEventListener("error", () => {
        if (image.isConnected && image.dataset.inView === "true") {
          showThumbnailFallback(image, "Impossible d’afficher cette miniature.");
        }
      });
      if (image.complete && image.naturalWidth > 0) image.classList.add("is-loaded");
    }
    if (thumbnailObserver) thumbnailObserver.observe(image);
    else {
      image.dataset.inView = "true";
      loadThumbnail(image);
    }
  }
}

function releaseAllThumbnails() {
  thumbnailGeneration += 1;
  if (thumbnailObserver) thumbnailObserver.disconnect();
  for (const url of thumbnailUrls.values()) URL.revokeObjectURL(url);
  thumbnailUrls.clear();
  thumbnailRequests.clear();
}

function buildLibrary(root, trashRoot = storage?.trash) {
  const folders = [];
  const files = [];
  filesById = new Map();
  folderNodesByPath = new Map([["__root__", root]]);
  if (trashRoot) folderNodesByPath.set("__trash__", trashRoot);
  cacheKeysByFile = new WeakMap();
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
        folderNodesByPath.set(path, node);
        visit(node, path, displayPath, isTrash);
        continue;
      }

      const extension = getExtension(name);
      const type = imageExtensions.has(extension) ? "photo" : videoExtensions.has(extension) ? "video" : null;
      if (!type) continue;

      const id = nextFileId++;
      const cacheKey = storage?.user && node.nodeId
        ? `${storage.user}:${node.nodeId}:${node.timestamp || 0}:${node.size || 0}`
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
        trashed: isTrash
      };
      files.push(record);
      filesById.set(id, node);
      if (cacheKey) cacheKeysByFile.set(node, cacheKey);
    }
  }

  visit(root, "", "", false);
  if (trashRoot) {
    visit(trashRoot, "", "", true);
  }
  return { files, folders };
}

function closeStorage() {
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

function saveMegaSession(candidate) {
  const { key, sid, name, user } = candidate.toJSON();
  sessionStorage.setItem(sessionStorageKey, JSON.stringify({
    key,
    sid,
    name,
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
    accountName: storage.name || storage.email
  });
  if (dialog.open) dialog.close();
  updateCacheStatus();
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

async function refreshMegaLibraryFromDrive() {
  const previousStorage = storage;
  if (!previousStorage) throw new Error("Connectez-vous à MEGA pour actualiser la bibliothèque.");
  const { key, sid, name, user } = previousStorage.toJSON();
  let candidate;
  try {
    candidate = Storage.fromJSON({
      key,
      sid,
      name,
      user,
      options: { email: previousStorage.email, keepalive: true }
    });
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
    throw new Error("La connexion MEGA a changé pendant l’actualisation.");
  }

  storage = candidate;
  closeStorageLocally(previousStorage);
  const library = buildLibrary(candidate.root, candidate.trash);
  window.megaGallery.refreshLibrary(library);
  await updateCacheStatus();
  return library;
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
    window.megaGallery.showToast("La session MEGA enregistrée est illisible. Reconnectez-vous.");
    return;
  }

  let candidate;
  try {
    candidate = Storage.fromJSON({
      key: savedSession.key,
      sid: savedSession.sid,
      name: savedSession.name || "",
      user: savedSession.user || "",
      options: { email: savedSession.email, keepalive: true }
    });
    await candidate.ready;
    candidate.status = "connecting";
    await candidate.reload(true);
    candidate.status = "ready";
    displayConnectedLibrary(candidate);
  } catch (error) {
    if (candidate) closeStorageLocally(candidate);
    console.error("Échec de la restauration de la session MEGA.", error);
    window.megaGallery.showToast("Session MEGA indisponible. Vérifiez votre connexion puis reconnectez-vous.");
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
    candidate = new Storage({
      email,
      password,
      ...(secondFactorCode ? { secondFactorCode } : {})
    });
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
  clearPersistentCache,
  updateCacheStatus,
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
    await refreshMegaLibraryFromDrive();
    const refreshedFile = storage.files[String(file.nodeId)];
    if (!refreshedFile || refreshedFile.name !== newName) {
      throw new Error("Le renommage a été envoyé, mais le nouveau nom n’a pas été confirmé par MEGA.");
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
    const library = await refreshMegaLibraryFromDrive();
    if (!library.folders.some((entry) => entry.path === String(path) && entry.name === newName)) {
      throw new Error("Le renommage a été envoyé, mais le nouveau nom n’a pas été confirmé par MEGA.");
    }
    return newName;
  },
  async deleteFolder(path) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de supprimer un dossier.");
    const folder = folderNodesByPath.get(String(path));
    if (!folder?.directory || folder === storage.root) throw new Error("Ce dossier n’existe plus dans MEGA.");
    const folderName = folder.name;
    await folder.delete(false);
    const library = await refreshMegaLibraryFromDrive();
    if (library.folders.some((entry) => entry.path === String(path))) {
      throw new Error("La suppression a été envoyée, mais le dossier apparaît toujours dans MEGA.");
    }
    return folderName;
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
    const library = await refreshMegaLibraryFromDrive();
    const expectedParentPath = parentPath === "__root__" ? "" : String(parentPath);
    const created = library.folders.find((entry) =>
      entry.parentPath === expectedParentPath && entry.name === folderName
    );
    if (!created) throw new Error("Le dossier a été créé dans MEGA, mais il n’a pas pu être rechargé dans l’arborescence.");
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
        await refreshMegaLibraryFromDrive();
      } catch (error) {
        throw new Error(`Les fichiers ont été envoyés, mais la bibliothèque n’a pas pu être actualisée : ${error instanceof Error ? error.message : "erreur inconnue"}`);
      }
      const refreshedParent = folderNodesByPath.get(String(parentPath));
      for (const entry of uploaded) {
        if (!(refreshedParent?.children || []).some((child) => String(child.nodeId) === entry.nodeId)) {
          failed.push({ title: entry.title, message: "L’envoi a été effectué, mais le fichier n’a pas été retrouvé après actualisation." });
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

    if (moved.length) window.megaGallery.refreshLibrary(buildLibrary(storage.root, storage.trash));
    return { moved, failed };
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

    if (succeeded.length) window.megaGallery.refreshLibrary(buildLibrary(storage.root, storage.trash));
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
        const inTrash = file.parent === storage.trash || file.trashed;
        await file.delete(inTrash ? true : false);
        if (inTrash) {
          if (storage.trash?.children) {
            const idx = storage.trash.children.indexOf(file);
            if (idx >= 0) storage.trash.children.splice(idx, 1);
          }
        } else {
          if (previousParent && previousParent !== storage.trash) {
            let previousIndex;
            while ((previousIndex = previousParent.children?.indexOf(file) ?? -1) >= 0) {
              previousParent.children.splice(previousIndex, 1);
            }
          }
          if (storage.trash?.children && !storage.trash.children.includes(file)) storage.trash.children.push(file);
          file.parent = storage.trash;
        }
        succeeded.push({ fileKey: String(file.nodeId), title: file.name });
      } catch (error) {
        failed.push({
          fileKey: String(file.nodeId),
          title: file.name,
          message: error instanceof Error ? error.message : "La suppression MEGA a échoué."
        });
      }
    }

    if (succeeded.length) window.megaGallery.refreshLibrary(buildLibrary(storage.root, storage.trash));
    return { succeeded, failed };
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
        count++;
      } catch (err) {
        console.error("Échec de la suppression définitive d’un élément de la corbeille :", item.name, err);
        errors.push(item.name);
      }
    }
    try {
      await refreshMegaLibraryFromDrive();
    } catch (refreshErr) {
      console.warn("Actualisation après vidage de corbeille :", refreshErr);
      window.megaGallery.refreshLibrary(buildLibrary(storage.root, storage.trash));
    }
    if (errors.length) {
      throw new Error(`Certains éléments n’ont pas pu être supprimés (${errors.join(", ")}).`);
    }
    return { count };
  },
  async downloadPreview(id) {
    const file = filesById.get(Number(id));
    if (!file) throw new Error("Ce fichier n’est plus disponible dans la session MEGA.");
    const isVideo = videoExtensions.has(getExtension(file.name));
    const limit = isVideo ? videoPreviewLimit : photoPreviewLimit;
    if (Number(file.size) > limit) {
      throw new Error(`Ce fichier dépasse la limite de lecture en mémoire de ${isVideo ? 100 : 30} Mo.`);
    }
    if (isVideo) {
      const video = document.createElement("video");
      if (!video.canPlayType(getMimeType(file.name, "video"))) {
        throw new Error("Ce format vidéo n’est pas pris en charge par le navigateur.");
      }
    }
    const blob = new Blob([await downloadBuffer(file)], {
      type: getMimeType(file.name, isVideo ? "video" : "photo")
    });
    return URL.createObjectURL(blob);
  }
};

updateCacheStatus();
restoreMegaSession();
window.addEventListener("pagehide", () => {
  releaseAllThumbnails();
  closeStorage();
});
