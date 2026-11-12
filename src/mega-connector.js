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
const cacheLimit = 200 * 1024 * 1024;
const cacheEntryLimit = 400;
const sessionStorageKey = "mega-gallery-session";
const thumbnailUrls = new Map();
const thumbnailRequests = new Map();
const thumbnailQueue = [];
let activeThumbnailDownloads = 0;
let thumbnailObserver = null;
let thumbnailGeneration = 0;
let cacheDatabasePromise = null;
let cacheUnavailableReason = "";
let cacheNotice = "";
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
  const seconds = Number(node.timestamp || node.createdAt);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString().slice(0, 10);
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

function getCacheDatabase() {
  if (cacheUnavailableReason) return Promise.reject(new Error(cacheUnavailableReason));
  if (!("indexedDB" in window)) {
    cacheUnavailableReason = "IndexedDB n’est pas disponible dans ce navigateur.";
    return Promise.reject(new Error(cacheUnavailableReason));
  }
  if (!cacheDatabasePromise) {
    cacheDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(cacheDatabaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(cacheStoreName)) {
          const store = database.createObjectStore(cacheStoreName, { keyPath: "key" });
          store.createIndex("lastUsed", "lastUsed");
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
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

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Erreur de lecture du cache local."));
  });
}

async function getCachedBlob(key) {
  if (!key || cacheUnavailableReason) return null;
  const database = await getCacheDatabase();
  const transaction = database.transaction(cacheStoreName, "readwrite");
  const store = transaction.objectStore(cacheStoreName);
  const record = await requestResult(store.get(key));
  if (!record) return null;
  record.lastUsed = Date.now();
  store.put(record);
  return record.blob;
}

async function storeCachedBlob(key, blob) {
  if (!key || !blob || blob.size > cacheLimit || cacheUnavailableReason) return false;
  const database = await getCacheDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(cacheStoreName, "readwrite");
    const store = transaction.objectStore(cacheStoreName);
    let saved = false;
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result;
      const existing = records.find((record) => record.key === key);
      let totalBytes = records.reduce((sum, record) => sum + (record.bytes || 0), 0) - (existing?.bytes || 0);
      let count = records.length - (existing ? 1 : 0);
      const evictable = records.filter((record) => record.key !== key).sort((a, b) => a.lastUsed - b.lastUsed);

      while ((totalBytes + blob.size > cacheLimit || count >= cacheEntryLimit) && evictable.length) {
        const oldest = evictable.shift();
        store.delete(oldest.key);
        totalBytes -= oldest.bytes || 0;
        count -= 1;
      }

      if (totalBytes + blob.size > cacheLimit || count >= cacheEntryLimit) return;
      store.put({
        key,
        blob,
        bytes: blob.size,
        lastUsed: Date.now()
      });
      saved = true;
    };
    request.onerror = () => reject(request.error || new Error("Impossible de préparer le cache local."));
    transaction.oncomplete = () => resolve(saved);
    transaction.onerror = () => reject(transaction.error || new Error("Impossible d’enregistrer le cache local."));
    transaction.onabort = () => reject(transaction.error || new Error("Enregistrement du cache local annulé."));
  });
}

async function getCacheStats() {
  if (cacheUnavailableReason) {
    return { available: false, error: cacheUnavailableReason, bytes: 0, entries: 0 };
  }
  const database = await getCacheDatabase();
  const transaction = database.transaction(cacheStoreName, "readonly");
  const records = await requestResult(transaction.objectStore(cacheStoreName).getAll());
  return {
    available: true,
    bytes: records.reduce((sum, record) => sum + (record.bytes || 0), 0),
    entries: records.length,
    warning: cacheNotice
  };
}

async function updateCacheStatus() {
  try {
    const stats = await getCacheStats();
    window.megaGallery.setCacheStatus(stats);
    return stats;
  } catch (error) {
    cacheUnavailableReason = error.message || "Cache local indisponible.";
    const stats = { available: false, error: cacheUnavailableReason, bytes: 0, entries: 0 };
    window.megaGallery.setCacheStatus(stats);
    return stats;
  }
}

async function clearPersistentCache() {
  const database = await getCacheDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(cacheStoreName, "readwrite");
    transaction.objectStore(cacheStoreName).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Impossible de vider IndexedDB."));
    transaction.onabort = () => reject(transaction.error || new Error("Vidage du cache annulé."));
  });
  cacheNotice = "";
}

async function getOrCreateThumbnailBlob(file) {
  const key = cacheKeysByFile.get(file);
  if (key) {
    try {
      const cachedBlob = await getCachedBlob(key);
      if (cachedBlob) return cachedBlob;
    } catch (error) {
      cacheNotice = "Lecture du cache impossible ; les aperçus seront rechargés depuis MEGA.";
      console.warn("Lecture du cache des aperçus impossible ; téléchargement direct utilisé.", error);
      await updateCacheStatus();
    }
  }

  const isVideo = videoExtensions.has(getExtension(file.name));
  const blob = isVideo
    ? await createVideoThumbnail(file)
    : new Blob([await downloadBuffer(file)], { type: getMimeType(file.name, "photo") });

  if (key) {
    try {
      const saved = await storeCachedBlob(key, blob);
      cacheNotice = saved ? "" : "Cache saturé : cet aperçu reste disponible en mémoire seulement.";
      await updateCacheStatus();
    } catch (error) {
      cacheNotice = "Enregistrement impossible ; cet aperçu reste disponible en mémoire seulement.";
      console.warn("Écriture du cache des aperçus impossible ; l’aperçu reste en mémoire.", error);
      await updateCacheStatus();
    }
  }
  return blob;
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

function buildLibrary(root) {
  const folders = [];
  const files = [];
  filesById = new Map();
  folderNodesByPath = new Map([["__root__", root]]);
  cacheKeysByFile = new WeakMap();
  let nextFileId = 1;
  let nextFolderId = 1;

  function visit(directory, parentPath = "", parentDisplayPath = "") {
    for (const node of directory.children || []) {
      const name = node.name || "Sans nom";
      if (node.directory) {
        const nodeId = node.nodeId || `folder-${nextFolderId++}`;
        const path = parentPath ? `${parentPath}/${nodeId}` : nodeId;
        const displayPath = parentDisplayPath ? `${parentDisplayPath}/${name}` : name;
        folders.push({
          path,
          parentPath,
          name,
          displayPath,
          color: "#e9f1e6",
          emoji: "▰"
        });
        folderNodesByPath.set(path, node);
        visit(node, path, displayPath);
        continue;
      }

      const extension = getExtension(name);
      const type = imageExtensions.has(extension) ? "photo" : videoExtensions.has(extension) ? "video" : null;
      if (!type) continue;

      const id = nextFileId++;
      const cacheKey = storage.user && node.nodeId
        ? `${storage.user}:${node.nodeId}:${node.timestamp || 0}:${node.size || 0}`
        : null;
      const record = {
        id,
        title: name,
        folder: parentDisplayPath || "Mon drive",
        folderPath: parentPath,
        date: formatDate(node),
        size: formatSize(Number(node.size)),
        type,
        favorite: Boolean(node.favorited)
      };
      files.push(record);
      filesById.set(id, node);
      if (cacheKey) cacheKeysByFile.set(node, cacheKey);
    }
  }

  visit(root);
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
  const library = buildLibrary(storage.root);
  window.megaGallery.setLibrary({
    ...library,
    accountName: storage.name || storage.email
  });
}

async function restoreMegaSession() {
  const cryptoError = getWebCryptoError();
  if (cryptoError) {
    window.megaGallery.showToast(cryptoError);
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
    if (candidate) {
      candidate.close().catch((closeError) => {
        console.error("La session MEGA restaurée n’a pas pu être fermée proprement.", closeError);
      });
    }
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
    return;
  }
  const cryptoError = getWebCryptoError();
  if (cryptoError) {
    window.megaGallery.showToast(cryptoError);
    return;
  }
  errorOutput.textContent = "";
  form.reset();
  dialog.showModal();
  document.querySelector("#mega-email").focus();
});

document.querySelector("#mega-cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
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
  async moveFile(id, destinationPath) {
    if (!storage) throw new Error("Connectez-vous à MEGA avant de déplacer un fichier.");
    const file = filesById.get(Number(id));
    if (!file) throw new Error("Ce fichier n’est plus disponible dans la session MEGA.");
    const destination = folderNodesByPath.get(String(destinationPath));
    if (!destination?.directory) throw new Error("Le dossier de destination n’existe plus dans MEGA.");
    if (file.parent === destination) throw new Error("Ce fichier se trouve déjà dans ce dossier.");

    const previousParent = file.parent;
    await file.moveTo(destination);
    if (file.parent !== destination) {
      const previousIndex = previousParent?.children?.indexOf(file) ?? -1;
      if (previousIndex >= 0) previousParent.children.splice(previousIndex, 1);
      if (!destination.children.includes(file)) destination.children.push(file);
      file.parent = destination;
    }

    window.megaGallery.refreshLibrary(buildLibrary(storage.root));
    return { refreshed: true };
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
    const blob = !isVideo && cacheKeysByFile.has(file)
      ? await getOrCreateThumbnailBlob(file)
      : new Blob([await downloadBuffer(file)], { type: getMimeType(file.name, isVideo ? "video" : "photo") });
    return URL.createObjectURL(blob);
  }
};

updateCacheStatus();
restoreMegaSession();
window.addEventListener("pagehide", () => {
  releaseAllThumbnails();
  closeStorage();
});
