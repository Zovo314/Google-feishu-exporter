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
    downloadFile(msg.content, msg.filename + '.md', 'text/markdown')
      .then((id) => sendResponse({ success: true, downloadId: id }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
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

async function openPdfPrint(html, filename) {
  // Store HTML in session storage, open a helper print page
  const key = 'pdf_' + Date.now();
  try {
    await chrome.storage.session.set({ [key]: html });
  } catch (e) {
    // If storage fails (too large), fall back to downloading as HTML
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
