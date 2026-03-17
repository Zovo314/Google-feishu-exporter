// Content script: DOM extraction, style inlining, image conversion
// Uses scroll-capture to handle virtual rendering (feishu only keeps
// visible blocks in the DOM at any given time).

(() => {
  if (window.__feishuExporterLoaded) return;
  window.__feishuExporterLoaded = true;

  // ============================================================
  // Config
  // ============================================================

  const CONTAINER_SELECTORS = [
    '.docx-editor',
    '[data-testid="doc-content"]',
    '.doc-content-container',
    '.wiki-content',
    '.doc-body',
    '[contenteditable="true"]',
    '[class*="docx-editor"]',
    '[class*="docContent"]',
    '[class*="doc-content"]',
    '[class*="doc_content"]',
    '[class*="editor-container"]',
    '[class*="sheet-container"]',
    '[role="main"]',
    'main',
    'article',
  ];

  const STYLE_PROPERTIES = [
    'font-family', 'font-size', 'font-weight', 'font-style',
    'color', 'background-color', 'background-image',
    'text-align', 'text-decoration', 'text-indent', 'text-transform',
    'line-height', 'letter-spacing', 'word-spacing',
    'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
    'border-top', 'border-bottom', 'border-left', 'border-right',
    'border-collapse', 'border-spacing',
    'display', 'white-space', 'vertical-align',
    'width', 'max-width', 'min-width',
    'list-style-type', 'list-style-position',
  ];

  const REMOVE_SELECTORS = [
    'script', 'link[rel="stylesheet"]', 'noscript', 'iframe',
    '[class*="tooltip"]', '[class*="Tooltip"]',
    '[class*="popover"]', '[class*="Popover"]',
    '[class*="copy-content"]', '[class*="CopyContent"]',
    '[class*="table-copy"]', 'textarea',
  ];

  const IMAGE_BATCH_SIZE = 5;

  // Default style cache (shared across calls)
  const defaultStyleCache = new Map();

  // ============================================================
  // Message handler
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start-export') {
      handleExport(msg.options)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });

  // ============================================================
  // Main export flow
  // ============================================================

  async function handleExport(options) {
    try {
      reportProgress('正在查找文档内容...', 5);

      const container = findDocContainer();
      if (!container) {
        throw new Error('未找到文档内容，请确认当前页面是飞书文档');
      }

      // Scroll-capture: scroll through the document, cloning each block
      // with its styles as it becomes visible in the DOM.
      reportProgress('正在采集文档内容...', 8);
      const wrapper = await scrollCapture(container);

      // Cleanup non-content elements
      reportProgress('正在清理...', 80);
      cleanupClone(wrapper);

      // Convert images to base64
      if (options.includeImages) {
        reportProgress('正在转换图片...', 82);
        await convertImages(wrapper, (done, total) => {
          const pct = 82 + Math.round((done / total) * 12);
          reportProgress(`正在转换图片 (${done}/${total})...`, pct);
        });
      }

      // Assemble final HTML
      reportProgress('正在组装 HTML...', 95);
      const title = getDocTitle();
      const html = assembleHTML(wrapper, title);

      // Trigger download
      reportProgress('正在下载...', 97);
      const result = await chrome.runtime.sendMessage({
        type: 'download-html',
        html,
        filename: title,
      });

      if (!result.success) {
        throw new Error(result.error || '下载失败');
      }

      reportProgress('导出完成！', 100);
      return { success: true };
    } catch (err) {
      console.error('[Feishu Exporter]', err);
      return { success: false, error: err.message };
    }
  }

  // ============================================================
  // Scroll-capture: incrementally scroll and capture blocks
  // ============================================================

  /**
   * Feishu's DOM structure:
   *   container (contenteditable / docx-editor)
   *     └─ div[data-block-type="page"]
   *         └─ .page-block-children
   *             └─ .root-render-unit-container   ← "blockContainer"
   *                 ├─ .render-unit-wrapper       (visible block)
   *                 ├─ .render-unit-wrapper       (visible block)
   *                 └─ .bear-virtual-renderUnit-placeholder  (all others)
   *
   * The virtual renderer swaps render-unit-wrappers in/out as the user scrolls.
   * We must scroll incrementally and capture each wrapper as it appears.
   */

  function findBlockContainer(container) {
    // Try feishu-specific selectors first (most specific → least)
    const selectors = [
      '.root-render-unit-container',
      '.page-block-children',
      '[class*="render-unit-container"]',
      '[class*="block-children"]',
    ];
    for (const sel of selectors) {
      const el = container.querySelector(sel);
      if (el) return el;
    }
    // Fallback: the container itself
    return container;
  }

  async function scrollCapture(container) {
    const blockContainer = findBlockContainer(container);
    const scrollEl = findScrollParent(blockContainer) || findScrollParent(container) || document.documentElement;
    const useWindow = (scrollEl === document.documentElement || scrollEl === document.body);

    const getScrollTop = () => useWindow ? window.scrollY : scrollEl.scrollTop;
    const setScrollTop = (v) => {
      if (useWindow) window.scrollTo(0, v);
      else scrollEl.scrollTop = v;
    };
    const getTotalHeight = () => useWindow
      ? document.documentElement.scrollHeight
      : scrollEl.scrollHeight;
    const getViewportHeight = () => useWindow
      ? window.innerHeight
      : scrollEl.clientHeight;

    const originalScroll = getScrollTop();
    const viewportH = getViewportHeight();
    const scrollStep = Math.floor(viewportH * 0.5); // 50% overlap for safety

    const capturedBlocks = new Map(); // key -> { clone, blockId, captureOrder }
    let captureOrder = 0;

    let currentScroll = 0;
    let step = 0;

    while (true) {
      const totalHeight = getTotalHeight();
      const target = currentScroll;
      setScrollTop(target);
      await sleep(400); // wait for virtual renderer to swap blocks in

      // Capture currently rendered blocks inside the block container
      captureOrder = captureVisibleBlocks(blockContainer, capturedBlocks, captureOrder);

      const pct = 8 + Math.min(70, Math.round((target / (totalHeight - viewportH || 1)) * 70));
      reportProgress(`正在采集文档内容 (${capturedBlocks.size} 块)...`, Math.max(8, pct));

      if (target >= totalHeight - viewportH) {
        // Reached the document bottom, wait a bit and check if it expands
        await sleep(500);
        captureOrder = captureVisibleBlocks(blockContainer, capturedBlocks, captureOrder);
        const newTotalHeight = getTotalHeight();
        if (newTotalHeight > totalHeight) {
          // Document expanded, keep going
          currentScroll += scrollStep;
          continue;
        }
        break;
      }

      currentScroll += scrollStep;
      if (currentScroll > totalHeight - viewportH) {
         currentScroll = totalHeight - viewportH;
      }
      step++;

      if (step > 5000) {
          console.warn('[Feishu Exporter] Stop scrolling: Max steps reached');
          break;
      }
    }

    // Restore scroll position
    setScrollTop(originalScroll);

    // Feishu block IDs might be alphanumeric hashes, which parseInt treats as NaN.
    // DOM capture order strictly follows document order since we scroll top-to-bottom.
    const sorted = [...capturedBlocks.values()].sort((a, b) => {
      return a.captureOrder - b.captureOrder;
    });

    const wrapper = document.createElement('div');
    for (const { clone } of sorted) {
      wrapper.appendChild(clone);
    }

    console.log(`[Feishu Exporter] Captured ${capturedBlocks.size} blocks in ${step} scroll steps`);
    return wrapper;
  }

  /**
   * Walk the block container's children, find actual content blocks
   * (skip placeholders), clone them with styles, and add to the map.
   * Returns updated captureOrder counter.
   */
  function captureVisibleBlocks(blockContainer, capturedBlocks, captureOrder) {
    // Get all rendered content blocks
    // Feishu wraps each block in .render-unit-wrapper
    let blocks = blockContainer.querySelectorAll('.render-unit-wrapper > [data-block-type]');
    if (blocks.length === 0) {
      blocks = blockContainer.querySelectorAll('[data-block-type]');
    }
    if (blocks.length === 0) {
      blocks = [...blockContainer.children].filter(
        (c) => !c.classList.contains('bear-virtual-renderUnit-placeholder')
          && !c.classList.contains('bear-virtual-pre-renderer')
          && c.offsetHeight > 0
      );
    }

    // Filter out blocks nested inside other [data-block-type] blocks
    // (e.g. text blocks inside table cells — already captured via parent clone)
    blocks = [...blocks].filter(block => {
      let parent = block.parentElement;
      while (parent && parent !== blockContainer) {
        if (parent.hasAttribute('data-block-type')) return false;
        parent = parent.parentElement;
      }
      return true;
    });

    for (const block of blocks) {
      const key = blockKey(block);
      if (capturedBlocks.has(key)) continue;

      const clone = deepClone(block);
      inlineSubtreeStyles(block, clone);

      // Capture images from the live DOM right now (blob: URLs may be revoked later).
      // For each img in the original block, if it's loaded, grab it via canvas.
      const origImgs = block.querySelectorAll('img');
      const cloneImgs = clone.querySelectorAll('img');
      for (let ii = 0; ii < Math.min(origImgs.length, cloneImgs.length); ii++) {
        const origImg = origImgs[ii];
        if (origImg.naturalWidth > 0 && origImg.naturalHeight > 0) {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = origImg.naturalWidth;
            canvas.height = origImg.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(origImg, 0, 0);
            cloneImgs[ii].setAttribute('src', canvas.toDataURL('image/png'));
            cloneImgs[ii].removeAttribute('srcset');
            cloneImgs[ii].removeAttribute('loading');
          } catch {
            // CORS tainted canvas — will be handled in convertImages later
          }
        }
      }

      const idStr = block.getAttribute('data-block-id');
      capturedBlocks.set(key, {
        clone,
        blockId: idStr ? parseInt(idStr, 10) : null,
        captureOrder: captureOrder++,
      });
    }

    return captureOrder;
  }

  /**
   * Generate a deduplication key for a block element.
   */
  function blockKey(el) {
    // Prefer data-block-id or data-record-id (feishu's own block identifiers)
    const blockId = el.getAttribute('data-block-id');
    if (blockId) return `block:${blockId}`;
    const recordId = el.getAttribute('data-record-id');
    if (recordId) return `record:${recordId}`;

    // Check other identity attributes
    for (const attr of el.attributes) {
      if (/^data-.*(index|key|node-id|id)/i.test(attr.name) && attr.value) {
        return `attr:${attr.name}=${attr.value}`;
      }
    }
    if (el.id) return `id:${el.id}`;

    // Fallback: tag + text signature
    const text = el.textContent.trim();
    const sig = text.substring(0, 150) + '|' + text.length;
    return `content:${el.tagName}:${sig}`;
  }

  // ============================================================
  // Document container detection
  // ============================================================

  function findDocContainer() {
    for (const sel of CONTAINER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 50) {
        return el;
      }
    }
    return findLargestContentBlock();
  }

  function findLargestContentBlock() {
    const candidates = document.querySelectorAll('div');
    let best = null;
    let bestScore = 0;

    for (const div of candidates) {
      const text = div.textContent.trim();
      if (text.length < 200) continue;

      const richChildren = div.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, span');
      if (richChildren.length < 3) continue;

      const score = text.length * 0.3 + richChildren.length * 50;

      const depth = getDepth(div);
      if (depth < 3) continue;

      const ratio = div.scrollHeight / document.body.scrollHeight;
      if (ratio > 0.95) continue;
      if (div.scrollHeight < 200) continue;

      if (score > bestScore) {
        bestScore = score;
        best = div;
      }
    }

    return best;
  }

  function getDepth(el) {
    let depth = 0;
    let node = el;
    while (node.parentElement) {
      depth++;
      node = node.parentElement;
    }
    return depth;
  }

  // ============================================================
  // Scroll parent detection
  // ============================================================

  function findScrollParent(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const overflow = style.overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  // ============================================================
  // Deep clone (handles Shadow DOM)
  // ============================================================

  function deepClone(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.cloneNode(true);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return node.cloneNode(true);
    }

    const clone = node.cloneNode(false);

    for (const child of node.childNodes) {
      clone.appendChild(deepClone(child));
    }

    if (node.shadowRoot) {
      for (const shadowChild of node.shadowRoot.childNodes) {
        clone.appendChild(deepClone(shadowChild));
      }
    }

    return clone;
  }

  // ============================================================
  // Style inlining (per-subtree, used during scroll-capture)
  // ============================================================

  function getDefaultStyles(tagName) {
    if (defaultStyleCache.has(tagName)) {
      return defaultStyleCache.get(tagName);
    }
    const temp = document.createElement(tagName);
    document.body.appendChild(temp);
    const defaults = {};
    const cs = getComputedStyle(temp);
    for (const prop of STYLE_PROPERTIES) {
      defaults[prop] = cs.getPropertyValue(prop);
    }
    document.body.removeChild(temp);
    defaultStyleCache.set(tagName, defaults);
    return defaults;
  }

  function inlineSubtreeStyles(original, clone) {
    const origEls = [original, ...original.querySelectorAll('*')];
    const cloneEls = [clone, ...clone.querySelectorAll('*')];
    const count = Math.min(origEls.length, cloneEls.length);

    for (let i = 0; i < count; i++) {
      try {
        const origEl = origEls[i];
        const cloneEl = cloneEls[i];
        const computed = getComputedStyle(origEl);
        const defaults = getDefaultStyles(origEl.tagName);
        const inlined = [];

        for (const prop of STYLE_PROPERTIES) {
          const val = computed.getPropertyValue(prop);
          if (val && val !== defaults[prop]) {
            inlined.push(`${prop}:${val}`);
          }
        }

        if (inlined.length > 0) {
          cloneEl.setAttribute('style', inlined.join(';'));
        }
      } catch {
        // skip
      }
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  function cleanupClone(clone) {
    for (const sel of REMOVE_SELECTORS) {
      try {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
      } catch {}
    }

    // Remove hidden copy elements and offscreen buffers
    clone.querySelectorAll('*').forEach((el) => {
      const style = el.getAttribute('style') || '';
      const isHidden = /display\s*:\s*none/i.test(style) 
        || /visibility\s*:\s*hidden/i.test(style) 
        || /opacity\s*:\s*0\b/i.test(style)
        || /width\s*:\s*0px/i.test(style) && /height\s*:\s*0px/i.test(style)
        || /width\s*:\s*1px/i.test(style) && /height\s*:\s*1px/i.test(style) && /overflow\s*:\s*hidden/i.test(style)
        || /clip\s*:\s*rect\(/i.test(style);
        
      const isOffscreen = (/position\s*:\s*absolute/i.test(style) || /position\s*:\s*fixed/i.test(style)) && (
        /left\s*:\s*-[1-9]/i.test(style) || /top\s*:\s*-[1-9]/i.test(style)
      );
      
      const isCopyBuffer = el.className && typeof el.className === 'string' && (
        el.className.includes('copy-content') || 
        el.className.includes('table-copy') || 
        el.className.includes('clipboard') ||
        el.className.includes('doc-copy') ||
        el.className.includes('copy-text')
      );

      if (isHidden || isOffscreen || isCopyBuffer) {
        el.remove();
      }
    });

    // Fix massive blank space above images: 
    // Feishu relies on padding and absolute position to preserve aspect ratios during lazy load.
    // Restoring position to static and stripping parent padding removes the blank visual artifacts.
    clone.querySelectorAll('img').forEach((img) => {
      let p = img.parentElement;
      while (p && p !== clone && p.tagName !== 'TD' && p.tagName !== 'TH' && p.tagName !== 'TABLE' && p.tagName !== 'TR') {
        if (p.style) {
          p.style.paddingTop = '';
          p.style.paddingBottom = '';
          p.style.height = 'auto';
          p.style.minHeight = '0';
        }
        p = p.parentElement;
      }
      img.style.position = 'static';
      img.style.transform = 'none';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
    });

    // Remove empty structural spacer divs
    clone.querySelectorAll('div').forEach((div) => {
      if (!div.textContent.trim() && !div.querySelector('img, svg, canvas, video, audio, table')) {
        const style = div.getAttribute('style') || '';
        if (/padding|height|margin/i.test(style)) {
          div.remove();
        }
      }
    });

    clone.querySelectorAll('*').forEach((el) => {
      const attrs = [...el.attributes];
      for (const attr of attrs) {
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
        }
      }
    });
  }

  // ============================================================
  // Image conversion
  // ============================================================

  async function convertImages(clone, onProgress) {
    const images = [...clone.querySelectorAll('img')];

    const bgElements = [...clone.querySelectorAll('*')].filter((el) => {
      const bg = el.style.backgroundImage;
      return bg && bg.startsWith('url(') && !bg.startsWith('url(data:');
    });

    const total = images.length + bgElements.length;
    if (total === 0) return;

    let done = 0;

    for (let i = 0; i < images.length; i += IMAGE_BATCH_SIZE) {
      const batch = images.slice(i, i + IMAGE_BATCH_SIZE);
      await Promise.all(
        batch.map(async (img) => {
          const src = img.getAttribute('src');
          if (!src || src.startsWith('data:')) { done++; return; }
          const dataURL = await imageToDataURL(src);
          if (dataURL) {
            img.setAttribute('src', dataURL);
          }
          img.removeAttribute('srcset');
          img.removeAttribute('loading');
          done++;
          onProgress(done, total);
        })
      );
    }

    for (let i = 0; i < bgElements.length; i += IMAGE_BATCH_SIZE) {
      const batch = bgElements.slice(i, i + IMAGE_BATCH_SIZE);
      await Promise.all(
        batch.map(async (el) => {
          const match = el.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
          if (!match) { done++; return; }
          const dataURL = await imageToDataURL(match[1]);
          if (dataURL) {
            el.style.backgroundImage = `url(${dataURL})`;
          }
          done++;
          onProgress(done, total);
        })
      );
    }
  }

  async function imageToDataURL(url) {
    // blob: URLs must be fetched from the page context (same origin)
    if (url.startsWith('blob:')) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const blob = await resp.blob();
          return await blobToDataURL(blob);
        }
      } catch {}
      return null;
    }

    const absoluteURL = new URL(url, location.href).href;
    const isCrossOrigin = new URL(absoluteURL).origin !== location.origin;

    // Strategy 1: fetch without credentials
    try {
      const resp = await fetch(absoluteURL, {
        credentials: 'omit',
        mode: isCrossOrigin ? 'cors' : 'same-origin',
      });
      if (resp.ok) {
        const blob = await resp.blob();
        return await blobToDataURL(blob);
      }
    } catch {}

    // Strategy 2: fetch with credentials (some feishu images need auth)
    if (isCrossOrigin) {
      try {
        const resp = await fetch(absoluteURL, { credentials: 'include' });
        if (resp.ok) {
          const blob = await resp.blob();
          return await blobToDataURL(blob);
        }
      } catch {}
    }

    // Strategy 3: proxy through background service worker
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'fetch-image',
        url: absoluteURL,
      });
      if (result?.success) {
        return result.dataURL;
      }
    } catch {}

    return null;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ============================================================
  // Document title
  // ============================================================

  function getDocTitle() {
    const metaTitle = document.querySelector('meta[property="og:title"]');
    if (metaTitle?.content) return metaTitle.content;

    const h1 = document.querySelector('h1');
    if (h1?.textContent?.trim()) return h1.textContent.trim();

    const title = document.title?.replace(/\s*[-|].*$/, '').trim();
    if (title) return title;

    return 'feishu-export';
  }

  // ============================================================
  // HTML assembly
  // ============================================================

  function assembleHTML(clone, title) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)}</title>
  <style>
    body {
      max-width: 900px;
      margin: 40px auto;
      padding: 0 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB",
        "Microsoft YaHei", sans-serif;
      font-size: 15px;
      line-height: 1.7;
      color: #1f2329;
      background: #fff;
    }
    img { max-width: 100%; height: auto; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
    }
    td, th {
      border: 1px solid #dee0e3;
      padding: 8px 12px;
    }
    pre, code {
      background: #f5f6f7;
      border-radius: 4px;
    }
    pre {
      padding: 12px 16px;
      overflow-x: auto;
    }
    code { padding: 2px 4px; font-size: 0.9em; }
    blockquote {
      border-left: 3px solid #3370ff;
      margin: 12px 0;
      padding: 8px 16px;
      color: #646a73;
    }
    hr { border: none; border-top: 1px solid #e5e6eb; margin: 24px 0; }
    a { color: #3370ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
${clone.innerHTML}
</body>
</html>`;
  }

  function escapeHTML(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================
  // Helpers
  // ============================================================

  function reportProgress(text, percent) {
    chrome.runtime.sendMessage({
      type: 'export-progress',
      text,
      percent,
    }).catch(() => {});
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
