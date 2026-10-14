import { fmt } from '../../time';
import type { ActionPreview, ActionResult } from '../../types';
import { clip, hardCap, oneLine } from './common';

function approvalLine(p: ActionPreview): string {
  if (p.approval === 'console' && p.approveUrl) {
    return `Show this preview to the user. They must approve it in the console: ${p.approveUrl} (confirm_action cannot approve this action).`;
  }
  return `Show this preview to the user. Call confirm_action with action_id "${p.actionId}" only after they agree; call cancel_action if they decline.`;
}

export function renderActionPreview(p: ActionPreview): string {
  const lines = [
    `Action preview: ${oneLine(p.title, 200)}`,
    `Type ${p.kind} · action_id ${p.actionId} · expires ${fmt(p.expiresAt)} JST`,
  ];
  if (p.details.length > 0) lines.push('', 'Details:', ...p.details.slice(0, 20).map((d) => `- ${clip(d, 400)}`));
  if (p.warnings.length > 0) lines.push('', 'Warnings:', ...p.warnings.slice(0, 10).map((w) => `- ${clip(w, 300)}`));
  lines.push('', approvalLine(p));
  return hardCap(lines.join('\n'));
}

export function renderActionResult(r: ActionResult): string {
  const lines = [`Action ${r.actionId}: ${r.status}. ${clip(r.message, 600)}`];
  if (r.url) lines.push(r.url);
  return lines.join('\n');
}
