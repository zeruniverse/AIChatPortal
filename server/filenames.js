import path from 'node:path';

const MAX_ARCHIVE_NAME_CODE_POINTS = 180;

function trimCodePoints(value, maxLength) {
  return Array.from(value).slice(0, maxLength).join('');
}

export function safeZipName(input, fallback = 'attachment') {
  const normalized = String(input || '')
    .normalize('NFC')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .at(-1) || '';

  let safe = normalized
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!safe || safe === '.' || safe === '..') safe = fallback;

  const extension = path.extname(safe);
  const stem = path.basename(safe, extension) || fallback;
  const extensionBudget = Math.min(Array.from(extension).length, 24);
  const safeExtension = trimCodePoints(extension, extensionBudget);
  const stemBudget = Math.max(1, MAX_ARCHIVE_NAME_CODE_POINTS - Array.from(safeExtension).length);
  safe = `${trimCodePoints(stem, stemBudget)}${safeExtension}`;

  if (!safe || safe === '.' || safe === '..') return fallback;
  return safe;
}

export function uniqueZipNames(files) {
  const used = new Set();
  return files.map((file, index) => {
    const fallback = `attachment-${index + 1}`;
    const safe = safeZipName(file.originalName, fallback);
    let candidate = safe;
    let counter = 2;
    const extension = path.extname(safe);
    const stem = path.basename(safe, extension) || fallback;
    while (used.has(candidate.toLocaleLowerCase('en-US'))) {
      const suffix = ` (${counter})`;
      const available = Math.max(1, MAX_ARCHIVE_NAME_CODE_POINTS
        - Array.from(extension).length
        - Array.from(suffix).length);
      candidate = `${trimCodePoints(stem, available)}${suffix}${extension}`;
      counter += 1;
    }
    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
  });
}
