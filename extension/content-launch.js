// Fallback capture: runs on launch.php pages and hands the launch link to the background worker.
// Only acts on pages the extension opened itself (marked with wmmExt=1).
(() => {
  if (!new URLSearchParams(location.search).has('wmmExt')) return;
  const a = document.getElementById('launchapp');
  const href = a ? a.getAttribute('href') : null;
  chrome.runtime.sendMessage({ type: 'wmm:launch-captured', href: href || null });
})();
