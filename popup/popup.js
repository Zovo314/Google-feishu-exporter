const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const exportBtn = document.getElementById('exportBtn');
const includeImages = document.getElementById('includeImages');
const pdfTip = document.getElementById('pdfTip');

let selectedFormat = 'html';

const formatLabels = {
  html: '导出为 HTML',
  pdf: '导出为 PDF',
  word: '导出为 Word',
  markdown: '导出为 Markdown',
};

// Format selector
document.querySelectorAll('.format-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedFormat = btn.dataset.format;
    exportBtn.textContent = formatLabels[selectedFormat];
    pdfTip.classList.toggle('show', selectedFormat === 'pdf');
  });
});

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (type ? ' ' + type : '');
}

function setProgress(pct) {
  progressBar.classList.add('active');
  progressFill.style.width = pct + '%';
}

function resetProgress() {
  progressBar.classList.remove('active');
  progressFill.style.width = '0%';
}

async function checkTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  const url = tab.url || '';
  const isFeishu = /https:\/\/([\w-]+\.)?(feishu\.cn|larksuite\.com)\//i.test(url);
  if (!isFeishu) {
    setStatus('请在飞书文档页面使用', 'error');
    exportBtn.disabled = true;
    return null;
  }
  return tab;
}

// Listen for progress messages from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'export-progress') {
    setStatus(msg.text);
    if (typeof msg.percent === 'number') {
      setProgress(msg.percent);
    }
  }
});

exportBtn.addEventListener('click', async () => {
  const tab = await checkTab();
  if (!tab) return;

  exportBtn.disabled = true;
  setStatus('正在导出...');
  setProgress(0);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'start-export',
      options: {
        includeImages: includeImages.checked,
        format: selectedFormat,
      },
    });

    if (response && response.success) {
      if (selectedFormat === 'pdf') {
        setStatus('已在新标签页打开，请选择「另存为PDF」', 'success');
      } else {
        setStatus('导出完成！', 'success');
      }
      setProgress(100);
    } else {
      setStatus(response?.error || '导出失败', 'error');
    }
  } catch (err) {
    setStatus('无法连接到页面，请刷新后重试', 'error');
    console.error(err);
  } finally {
    exportBtn.disabled = false;
    setTimeout(resetProgress, 2000);
  }
});

checkTab();
