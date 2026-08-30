export function shouldSubmit(event) {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229;
}
