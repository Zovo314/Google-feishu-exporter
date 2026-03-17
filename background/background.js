// Service Worker: handles CORS image proxy and download triggers

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetch-image') {
    fetchImageAsDataURL(msg.url, msg.cookies)
      .then((dataURL) => sendResponse({ success: true, dataURL }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async response
  }

  if (msg.type === 'download-html') {
    downloadHTML(msg.html, msg.filename)
      .then((id) => sendResponse({ success: true, downloadId: id }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchImageAsDataURL(url) {
  // Background service worker has host_permissions, no CORS restrictions
  // Use credentials: 'omit' to avoid CORS credential conflicts
  const response = await fetch(url, {
    credentials: 'omit',
  });

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

async function downloadHTML(html, filename) {
  // MV3 Service Worker has no URL.createObjectURL, use data URL instead
  const base64 = btoa(unescape(encodeURIComponent(html)));
  const dataURL = 'data:text/html;charset=utf-8;base64,' + base64;

  const downloadId = await chrome.downloads.download({
    url: dataURL,
    filename: sanitizeFilename(filename) + '.html',
    saveAs: true,
  });
  return downloadId;
}

function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'feishu-export';
  
  // Remove zero-width spaces, RTL marks, and non-printable Unicode chars
  let cleanName = name.replace(/[\u200B-\u200D\uFEFF]/g, '')
                      .replace(/[\u200E\u200F\u202A-\u202E]/g, '');
  
  // Replace invalid OS filename characters
  cleanName = cleanName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  
  // Collapse whitespace
  cleanName = cleanName.replace(/\s+/g, ' ').trim();
  
  // Chrome downloads API has a rough limit around ~255 bytes for the full path
  // Since Feishu titles can be very long (and CJK characters take 3 bytes),
  // we truncate to 80 characters to be safe.
  if (cleanName.length > 80) {
    cleanName = cleanName.substring(0, 80).trim();
  }
  
  // Prevent leading dot (hidden files) or empty filename
  if (cleanName.startsWith('.')) {
    cleanName = cleanName.substring(1).trim();
  }
  
  return cleanName || 'feishu-export';
}
