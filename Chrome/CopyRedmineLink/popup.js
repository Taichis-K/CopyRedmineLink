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

// URLが取れないタブ（chrome:// など activeTab が付与されないページ）は null を返す
// tabs 権限が無いため、そうしたページでは tab.url / tab.title が undefined になる
async function copyableTab() {
  const tab = await activeTab();
  return tab.url ? tab : null;
}

const MSG_UNCOPYABLE = 'This page cannot be copied';

function isRedmineUrl(url = "") {
  return /redmine|\/issues?\/|\/projects\/|tracker/i.test(url || "");
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

// ========== Slack：ポップアップ内でリッチテキストをコピー ==========
// 以前はタブのページへ executeScript(world: "MAIN") で注入し、ページ内で
// execCommand('copy') していたが、ポップアップ表示中はページにフォーカスが無く
// queryCommandEnabled('copy') が false になり、例外なしで失敗するようになった
// （Chrome 158 で確認）。フォーカスを持つポップアップ側でコピーする。
const SLACK_LINK_STYLE = 'color: rgb(6, 82, 45); text-decoration: none;';

function escapeHtml(s = "") {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Clipboard API で text/html と text/plain を同時に書き込む
// href はエスケープのみで文字列として埋め込むため、URLエンコーディングは保持される
async function copyRichTextByClipboardApi(text, href) {
  const html = `<a href="${escapeHtml(href)}" style="${SLACK_LINK_STYLE}">${escapeHtml(text)}</a>`;
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' })
    })
  ]);
}

// Selection + execCommand('copy') によるコピー（Clipboard API 失敗時の予備）
function copyRichTextBySelection(text, href) {
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';

  const a = document.createElement('a');
  // URLエンコードされた文字を保持するため、setAttribute を使用
  a.setAttribute('href', href);
  a.textContent = text;
  a.setAttribute('style', SLACK_LINK_STYLE);

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
    console.error('execCommand copy failed:', e);
  }

  sel.removeAllRanges();
  document.body.removeChild(container);
  return success;
}

// Slack用のコピー処理：Clipboard API → Selection → テキストの順で試す
async function performSlackCopy(tab) {
  const url = tab.url || '';
  const href = normalizeIssueHref(url);
  const baseTitle = extractRedmineIssueTitle(tab.title || '', url);
  const visible = slackVisibleFromCommonTitle(baseTitle);

  try {
    await copyRichTextByClipboardApi(visible, href);
    return { success: true, message: 'Copied (Slack)' };
  } catch (e) {
    console.error('Clipboard API write failed:', e);
  }

  if (copyRichTextBySelection(visible, href)) {
    return { success: true, message: 'Copied (Slack)' };
  }

  await navigator.clipboard.writeText(`${visible} - ${href}`);
  return { success: true, message: 'Copied as text' };
}

// ========== Handlers ==========

// Slack：Redmine抽出は共通 → 先頭#のみ「・」に置換 → リッチテキストコピー
async function copySlack() {
  try {
    const tab = await copyableTab();
    if (!tab) { setStatus(MSG_UNCOPYABLE, false); return; }
    const result = await performSlackCopy(tab);
    setStatus(result.message, result.success);
  } catch (e) {
    console.error('Error in copySlack:', e);
    setStatus('Failed (Slack)', false);
  }
}

// Redmine："#<番号>: 題名":URL（非Redmineは元タイトルをそのまま）
async function copyRedmine() {
  try {
    const tab = await copyableTab();
    if (!tab) { setStatus(MSG_UNCOPYABLE, false); return; }
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
    const tab = await copyableTab();
    if (!tab) { setStatus(MSG_UNCOPYABLE, false); return; }
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
