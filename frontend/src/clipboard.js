function legacyCopy(text) {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  textarea.className = 'clipboard-fallback';
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = Boolean(document.execCommand('copy'));
  } catch {
    copied = false;
  }
  textarea.remove();
  if (active && typeof active.focus === 'function') {
    try { active.focus({ preventScroll: true }); } catch { active.focus(); }
  }
  return copied;
}

export async function writeClipboardText(value) {
  const text = String(value ?? '');
  if (!text) return false;

  // The modern Clipboard API normally requires HTTPS. On ordinary HTTP, use
  // the synchronous fallback immediately so the click remains a user action.
  if (typeof window !== 'undefined'
    && window.isSecureContext
    && typeof navigator !== 'undefined'
    && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continue to the no-dialog fallback.
    }
  }
  return legacyCopy(text);
}
