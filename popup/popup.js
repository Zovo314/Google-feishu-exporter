const statusEl = document.getElementById('status');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const exportBtn = document.getElementById('exportBtn');
const includeImages = document.getElementById('includeImages');

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

// Check if current tab is a Feishu page
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
      },
    });

    if (response && response.success) {
      setStatus('导出完成！', 'success');
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

// Initial check
checkTab();
