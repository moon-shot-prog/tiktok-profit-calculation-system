(() => {
  const DB_NAME = 'tiktok-profit-local-archive';
  const STORE_NAME = 'settings';
  const KEY = 'directory-handle';

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function readHandle() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async function storeHandle(handle) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(handle, KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  }
  function safePart(value) { return String(value || '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 120); }
  function localFileName(file, batchCode, category) { return `原始导入_${safePart(category)}_${safePart(batchCode)}_${safePart(file.name)}`; }
  function downloadFallback(file, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file); link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  async function chooseDirectory() {
    if (!window.showDirectoryPicker) throw new Error('当前浏览器不支持选择本地归档文件夹，请使用最新版 Chrome 或 Edge。');
    const handle = await window.showDirectoryPicker({ id: 'tiktok-profit-import-archive', mode: 'readwrite' });
    await storeHandle(handle);
    return handle.name;
  }
  async function save(file, batchCode, category) {
    const name = localFileName(file, batchCode, category);
    try {
      const directory = await readHandle();
      if (directory && await directory.queryPermission({ mode: 'readwrite' }) === 'granted') {
        const target = await directory.getFileHandle(name, { create: true });
        const writable = await target.createWritable();
        await writable.write(file); await writable.close();
        return { location: 'folder', name, folder: directory.name };
      }
    } catch (_) {
      // A browser can revoke a saved directory permission at any time. Fall
      // back to a normal download instead of making a completed import fail.
    }
    downloadFallback(file, name);
    return { location: 'download', name };
  }
  window.localImportArchive = { chooseDirectory, save };
})();
