// Service Worker: handles CORS image proxy and download triggers

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetch-image') {
    fetchImageAsDataURL(msg.url)
      .then((dataURL) => sendResponse({ success: true, dataURL }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'download-html') {
    downloadFile(msg.html, msg.filename + '.html', 'text/html')
      .then((id) => sendResponse({ success: true, downloadId: id }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'download-markdown') {
    const images = msg.images || [];
    if (images.length > 0) {
      downloadMarkdownAsZip(msg.content, images, msg.filename)
        .then((id) => sendResponse({ success: true, downloadId: id }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
    } else {
      downloadFile(msg.content, msg.filename + '.md', 'text/markdown')
        .then((id) => sendResponse({ success: true, downloadId: id }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
    }
    return true;
  }

  if (msg.type === 'download-word') {
    downloadFile(msg.content, msg.filename + '.doc', 'application/msword')
      .then((id) => sendResponse({ success: true, downloadId: id }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'open-pdf-print') {
    openPdfPrint(msg.html, msg.filename)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchImageAsDataURL(url) {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  const mime = response.headers.get('content-type') || 'image/png';
  return `data:${mime};base64,${base64}`;
}

async function downloadFile(content, filename, mimeType) {
  const base64 = btoa(unescape(encodeURIComponent(content)));
  const dataURL = `data:${mimeType};charset=utf-8;base64,` + base64;
  const downloadId = await chrome.downloads.download({
    url: dataURL,
    filename: sanitizeFilename(filename),
    saveAs: true,
  });
  return downloadId;
}

async function downloadMarkdownAsZip(content, images, filename) {
  const folder = sanitizeFilename(filename);
  const files = [];

  // Add each image under {folder}/images/
  for (const { filename: imgFile, dataURL } of images) {
    files.push({
      name: `${folder}/images/${imgFile}`,
      data: dataURLToBytes(dataURL),
    });
  }

  // Add the markdown file under {folder}/
  files.push({
    name: `${folder}/${folder}.md`,
    data: new TextEncoder().encode(content),
  });

  const zipBytes = createZip(files);
  const zipDataURL = 'data:application/zip;base64,' + bytesToBase64(zipBytes);

  const downloadId = await chrome.downloads.download({
    url: zipDataURL,
    filename: `${folder}.zip`,
    saveAs: true,
  });
  return downloadId;
}

// ============================================================
// ZIP creator — STORE method (no compression), no dependencies
// ============================================================

// Build CRC-32 lookup table once at load time
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Create a ZIP archive from an array of { name: string, data: Uint8Array }.
 * Uses STORE (no compression) — valid for already-compressed images.
 * Returns a Uint8Array of the complete ZIP file.
 */
function createZip(files) {
  const enc = new TextEncoder();
  const entries = [];
  let offset = 0;

  // --- Local file headers + data ---
  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0,  0x04034b50, true); // local file header signature
    lv.setUint16(4,  20,         true); // version needed to extract
    lv.setUint16(6,  0,          true); // general purpose bit flag
    lv.setUint16(8,  0,          true); // compression method: STORE
    lv.setUint16(10, 0,          true); // last mod file time
    lv.setUint16(12, 0,          true); // last mod file date
    lv.setUint32(14, crc,        true); // CRC-32
    lv.setUint32(18, size,       true); // compressed size
    lv.setUint32(22, size,       true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // file name length
    lv.setUint16(28, 0,          true); // extra field length
    lh.set(nameBytes, 30);

    entries.push({ lh, data: file.data, nameBytes, crc, size, offset });
    offset += lh.length + size;
  }

  // --- Central directory ---
  const centralStart = offset;
  const centralParts = [];

  for (const { nameBytes, crc, size, offset: entryOffset } of entries) {
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0,  0x02014b50, true); // central directory file header sig
    cv.setUint16(4,  20,         true); // version made by
    cv.setUint16(6,  20,         true); // version needed to extract
    cv.setUint16(8,  0,          true); // general purpose bit flag
    cv.setUint16(10, 0,          true); // compression method: STORE
    cv.setUint16(12, 0,          true); // last mod file time
    cv.setUint16(14, 0,          true); // last mod file date
    cv.setUint32(16, crc,        true); // CRC-32
    cv.setUint32(20, size,       true); // compressed size
    cv.setUint32(24, size,       true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true); // file name length
    cv.setUint16(30, 0,          true); // extra field length
    cv.setUint16(32, 0,          true); // file comment length
    cv.setUint16(34, 0,          true); // disk number start
    cv.setUint16(36, 0,          true); // internal file attributes
    cv.setUint32(38, 0,          true); // external file attributes
    cv.setUint32(42, entryOffset, true); // relative offset of local header
    ch.set(nameBytes, 46);
    centralParts.push(ch);
    offset += ch.length;
  }

  const centralSize = offset - centralStart;

  // --- End of central directory record ---
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0,  0x06054b50,      true); // end of central dir signature
  ev.setUint16(4,  0,               true); // number of this disk
  ev.setUint16(6,  0,               true); // disk with start of central dir
  ev.setUint16(8,  entries.length,  true); // entries on this disk
  ev.setUint16(10, entries.length,  true); // total entries
  ev.setUint32(12, centralSize,     true); // size of central directory
  ev.setUint32(16, centralStart,    true); // offset of central directory
  ev.setUint16(20, 0,               true); // zip file comment length

  // --- Assemble final ZIP ---
  const zip = new Uint8Array(offset + 22);
  let pos = 0;
  for (const { lh, data } of entries) {
    zip.set(lh,   pos); pos += lh.length;
    zip.set(data, pos); pos += data.length;
  }
  for (const ch of centralParts) {
    zip.set(ch, pos); pos += ch.length;
  }
  zip.set(eocd, pos);

  return zip;
}

// ============================================================
// Binary helpers
// ============================================================

function dataURLToBytes(dataURL) {
  const base64 = dataURL.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  // Process in chunks to avoid call-stack overflow on large buffers
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ============================================================
// PDF print helper
// ============================================================

async function openPdfPrint(html, filename) {
  const key = 'pdf_' + Date.now();
  try {
    await chrome.storage.session.set({ [key]: html });
  } catch (e) {
    await downloadFile(html, filename + '.html', 'text/html');
    throw new Error('文档过大，已改为下载 HTML，请用浏览器打印另存为 PDF');
  }
  const printUrl = chrome.runtime.getURL(`pdf-print/print.html?key=${key}&title=${encodeURIComponent(filename)}`);
  await chrome.tabs.create({ url: printUrl });
}

function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'feishu-export';
  let cleanName = name
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u200E\u200F\u202A-\u202E]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanName.length > 80) cleanName = cleanName.substring(0, 80).trim();
  if (cleanName.startsWith('.')) cleanName = cleanName.substring(1).trim();
  return cleanName || 'feishu-export';
}
