export function isSubmitShortcut(event) {
  if (!event || event.key !== 'Enter' || event.isComposing) return false;
  if (event.shiftKey) return false;
  return Boolean(event.ctrlKey || event.metaKey);
}

export function submitOnShortcut(event, submit) {
  if (!isSubmitShortcut(event)) return false;
  event.preventDefault?.();
  submit();
  return true;
}
