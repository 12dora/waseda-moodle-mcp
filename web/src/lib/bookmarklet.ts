/** Bookmarklet generator. The script body is fixed by contract §8 + §11; only S and the alert strings vary. */

export const MOODLE_ORIGIN = 'https://wsdmoodle.waseda.jp';

interface BookmarkletMessages {
  /** Shown when no launch link is found (not signed in to Moodle). */
  signin: string;
  /** Shown on any unexpected failure. */
  fail: string;
}

/** Escape for a single-quoted JS string literal. */
function jsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n|\r|\u2028|\u2029/g, ' ');
}

/** Raw JavaScript source (no `javascript:` prefix). Hands the launch link over via POST, never in a URL (§11). */
export function bookmarkletSource(publicUrl: string, msgs: BookmarkletMessages): string {
  const S = jsString(publicUrl.replace(/\/+$/, ''));
  const signin = jsString(msgs.signin);
  const fail = jsString(msgs.fail);
  return (
    `(async()=>{const S='${S}',M='${MOODLE_ORIGIN}';if(location.origin!==M){location.href=M+'/my/';return}` +
    `try{const p=Math.random().toString(36).slice(2,10);const r=await fetch(M+'/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport='+p+'&urlscheme=moodlemobile&confirmed=1',{credentials:'include'});` +
    `const h=await r.text();const m=h.match(/id="launchapp"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*id="launchapp"/);const u=m&&(m[1]||m[2]);` +
    `if(!u){alert('${signin}');return}` +
    `const q=await fetch(S+'/api/connect/handoff',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({launch:u.replace(/&amp;/g,'&'),via:'bookmarklet',passport:p})});` +
    `if(!q.ok)throw new Error(String(q.status));const d=await q.json();location.href=S+'/connect?code='+encodeURIComponent(d.code)}catch(e){alert('${fail}')}})()`
  );
}

/**
 * Percent-encode only what a `javascript:` URL cannot carry verbatim: `%` (the browser percent-decodes the
 * body), `#` (would start a fragment), whitespace/control characters, non-ASCII, and quote/angle/backtick
 * characters that some bookmark managers mangle.
 */
export function encodeJsUrlBody(src: string): string {
  return src.replace(/[%#"<>`\s]|[^\x20-\x7e]/gu, (c) => encodeURIComponent(c));
}

export function bookmarkletHref(publicUrl: string, msgs: BookmarkletMessages): string {
  return `javascript:${encodeJsUrlBody(bookmarkletSource(publicUrl, msgs))}`;
}
