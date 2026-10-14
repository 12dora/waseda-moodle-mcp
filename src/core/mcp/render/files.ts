import { formatBytes } from '../../format';
import { fmt } from '../../time';
import type { FileLink, UploadLink } from '../../types';
import { hardCap, oneLine } from './common';

/** Shell-safe file name for the curl example. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'download';
}

export function renderFileLink(link: FileLink): string {
  const meta = [link.mime, link.size !== null ? formatBytes(link.size) : null].filter(Boolean).join(', ');
  const lines = [`File: ${oneLine(link.name, 120)}${meta ? ` (${meta})` : ''}`];
  if (link.downloadUrl.startsWith('file://')) {
    lines.push(`Saved locally: ${link.downloadUrl}`);
  } else {
    lines.push(`Download URL (valid until ${fmt(link.expiresAt)} JST, single-user, do not share): ${link.downloadUrl}`);
    lines.push(`Example: curl -fL -o '${safeName(link.name)}' '${link.downloadUrl}'`);
  }
  if (link.inline) lines.push('The content is also attached to this result.');
  return hardCap(lines.join('\n'));
}

export function renderUploadLink(u: UploadLink & { uploadId?: string }, cmid?: number): string {
  const lines = [
    `Upload URL (valid until ${fmt(u.expiresAt)} JST, max ${formatBytes(u.maxBytes)} per file): ${u.uploadUrl}`,
    'Send the raw bytes with PUT or POST and the file name as ?name=. Example:',
    u.curlExample,
  ];
  if (u.uploadId) {
    const forCmid = cmid !== undefined ? `cmid ${cmid} and ` : '';
    lines.push(`After uploading, call prepare_submission with ${forCmid}upload_id "${u.uploadId}".`);
  }
  return hardCap(lines.join('\n'));
}
