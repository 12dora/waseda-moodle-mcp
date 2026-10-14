/** Clipboard write with a legacy fallback for non-secure contexts and older browsers. */
export async function copyText(text: string, field?: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  if (!field) return false;
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  }
}
