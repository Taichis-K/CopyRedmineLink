// ========== 小道具 ==========
function setStatus(msg, ok = true) {
  const s = document.getElementById('status');
  s.textContent = msg;
  s.className = 'status ' + (ok ? 'ok' : 'ng');
  setTimeout(() => { s.textContent = ''; s.className = 'status'; }, 1600);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || {};
}

function isRedmineUrl(url = "") {
  return /redmine|\/issues?\/|\/projects\/|tracker/i.test(url || "");
}

function isRestrictedPage(url = "") {
  return url.startsWith('chrome://') ||
         url.startsWith('chrome-extension://') ||
         url.includes('chromewebstore.google.com');
}

function normalizeIssueHref(pageUrl = "") {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/issues\/(\d+)/);
    if (m) return `${u.protocol}//${u.host}/issues/${m[1]}`;
    return pageUrl;
  } catch { return pageUrl; }
}

// ========== 共通：Redmineタイトル抽出（非Redmineは触らない） ==========
// 返却：
// - Redmine: 「#<番号>: <題名>」に正規化して返す
// - 非Redmine: titleそのまま返す
function extractRedmineIssueTitle(pageTitle = "", pageUrl = "") {
  if (!isRedmineUrl(pageUrl)) return (pageTitle || "").trim();

  // Redmineっぽい末尾（" - プロジェクト - Redmine" 等）はまず落とす
  const head = (pageTitle || "").split(" - ")[0].trim();

  // どこにあっても "#数字: 題名" を拾う（間の全角：対応）
  let m = head.match(/#\s*(\d+)\s*[:：]\s*(.+)$/);
  if (m) return `#${m[1]}: ${m[2].trim()}`;

  // 「数字: 題名」だけのパターンも拾い、先頭に#を補う
  m = head.match(/^\s*(\d+)\s*[:：]\s*(.+)$/);
  if (m) return `#${m[1]}: ${m[2].trim()}`;

  // それでも駄目ならheadそのまま
  return head;
}

// Slackだけ：先頭#→・に置換（それ以外は一切改変しない）
function slackVisibleFromCommonTitle(commonTitle = "") {
  if (/^\s*#/.test(commonTitle)) {
    return "・" + commonTitle.replace(/^\s*#\s*/, "");
  }
  return commonTitle;
}

// ========== Slack：Selectionコピー（CF_HTMLはブラウザ生成） ==========
function pageCopyBySelection({ text, href, style }) {
  const a = document.createElement('a');
  // URLエンコードされた文字を保持するため、setAttribute を使用
  a.setAttribute('href', href);
  a.textContent = text;
  if (style) a.setAttribute('style', style);
  a.style.position = 'fixed'; a.style.left = '-9999px'; a.style.top = '0';
  document.body.appendChild(a);

  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNode(a);
  sel.removeAllRanges(); sel.addRange(range);

  const ok = document.execCommand('copy');

  sel.removeAllRanges();
  document.body.removeChild(a);
  return { ok, used: 'Selection+execCommand(copy)' };
}

// ポップアップ内でリッチテキストをコピー（制限されたページ用）
function copyRichTextInPopup(text, href) {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';

  const a = document.createElement('a');
  a.setAttribute('href', href);
  a.textContent = text;
  a.style.color = 'rgb(6, 82, 45)';
  a.style.textDecoration = 'none';

  container.appendChild(a);
  document.body.appendChild(container);

  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNode(a);
  sel.removeAllRanges();
  sel.addRange(range);

  let success = false;
  try {
    success = document.execCommand('copy');
  } catch (e) {
    console.error('Copy failed in popup:', e);
  }

  sel.removeAllRanges();
  document.body.removeChild(container);

  return success;
}

// Slack用のコピー処理（制限ページとフォールバック共通）
async function performSlackCopy(tab, usePopupMethod = false) {
  const url = tab.url || '';
  const href = normalizeIssueHref(url);
  const baseTitle = extractRedmineIssueTitle(tab.title || '', url);
  const visible = slackVisibleFromCommonTitle(baseTitle);

  if (usePopupMethod || isRestrictedPage(url)) {
    // ポップアップ内でのコピー処理
    const success = copyRichTextInPopup(visible, href);
    if (success) {
      return { success: true, message: 'Copied (Slack)' };
    } else {
      // テキスト形式にフォールバック
      const fallbackText = `${visible} - ${href}`;
      await navigator.clipboard.writeText(fallbackText);
      return { success: true, message: 'Copied as text' };
    }
  }

  // 通常のコンテンツスクリプト実行
  const style = "color: rgb(6, 82, 45); text-decoration: none;";
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: "MAIN",
    func: pageCopyBySelection,
    args: [{ text: visible, href, style }]
  });

  return {
    success: result && result.ok,
    message: result && result.ok ? 'Copied (Slack)' : 'Failed (Slack)'
  };
}

// ========== Handlers ==========

// Slack：Redmine抽出は共通 → 先頭#のみ「・」に置換 → Selectionコピー
async function copySlack() {
  try {
    const tab = await activeTab();
    const result = await performSlackCopy(tab);
    setStatus(result.message, result.success);
  } catch (e) {
    console.error('Error in copySlack:', e);
    console.error('Error details:', {
      message: e.message,
      stack: e.stack,
      tab: await activeTab()
    });

    // エラー時のフォールバック処理
    try {
      const tab = await activeTab();
      const result = await performSlackCopy(tab, true);  // ポップアップメソッドを強制使用
      setStatus(result.message + ' (fallback)', result.success);
    } catch (fallbackError) {
      console.error('Fallback also failed:', fallbackError);
      setStatus(`Error: ${e.message}`, false);
    }
  }
}

// Redmine："#<番号>: 題名":URL（非Redmineは元タイトルをそのまま）
async function copyRedmine() {
  try {
    const tab = await activeTab();
    const url = tab.url || '';
    const titleOut = extractRedmineIssueTitle(tab.title || '', url); // 共通抽出
    const text = `"${titleOut}":${url}`;
    await navigator.clipboard.writeText(text);
    setStatus('Copied (Redmine)', true);
  } catch (e) {
    console.error(e);
    setStatus('Failed (Redmine)', false);
  }
}

// Markdown：[Title](URL)（Redmine時は共通抽出を利用）
async function copyMarkdown() {
  try {
    const tab = await activeTab();
    const url = tab.url || '';
    const titleOut = extractRedmineIssueTitle(tab.title || '', url); // 共通抽出
    const text = `[${titleOut}](${url})`;
    await navigator.clipboard.writeText(text);
    setStatus('Copied (Markdown)', true);
  } catch (e) {
    console.error(e);
    setStatus('Failed (Markdown)', false);
  }
}

document.getElementById('btn-slack').addEventListener('click', copySlack);
document.getElementById('btn-redmine').addEventListener('click', copyRedmine);
document.getElementById('btn-md').addEventListener('click', copyMarkdown);
