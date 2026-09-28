import type { SelectedFile } from './types';

export const MAX_FILES = 100;
export const MAX_SIZE = 1_073_741_824; // 1 GB

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PNG = 'image/png';
const JPEG = 'image/jpeg';

const ALLOWED_TYPES = [PDF, DOCX, XLSX, PNG, JPEG];

// Non-standard MIME types some mobile browsers and file providers report.
const TYPE_ALIASES: Record<string, string> = {
  'image/jpg': JPEG,
  'image/pjpeg': JPEG,
  'application/x-pdf': PDF,
};

const TYPE_BY_EXT: Record<string, string> = {
  pdf: PDF,
  docx: DOCX,
  xlsx: XLSX,
  png: PNG,
  jpg: JPEG,
  jpeg: JPEG,
};

/**
 * Value for the file input's `accept` attribute. Lists both MIME types and
 * extensions: iOS Safari and Android Chrome build their pickers from MIME
 * types, desktop browsers filter by extension. Listing image/jpeg (and not
 * image/heic) also makes iOS hand over photos transcoded to JPEG.
 */
export const ACCEPT_ATTRIBUTE = [...ALLOWED_TYPES, ...Object.keys(TYPE_BY_EXT).map((ext) => `.${ext}`)].join(',');

/**
 * The content type DocPost sends for a file, or '' when the file is not a
 * supported type. Mobile pickers often report an empty or generic type
 * (e.g. application/octet-stream from Files or Google Drive), so fall back to
 * the extension.
 */
export function fileContentType(file: { name: string; type: string }): string {
  const reported = file.type.toLowerCase();
  const normalized = TYPE_ALIASES[reported] ?? reported;
  if (ALLOWED_TYPES.includes(normalized)) return normalized;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return '';
  return TYPE_BY_EXT[file.name.slice(dot + 1).toLowerCase()] ?? '';
}

/**
 * A client-side id. crypto.randomUUID only exists in secure contexts and on
 * iOS Safari 15.4+, so fall back to getRandomValues, then Math.random.
 */
export function createFileId(): string {
  const c = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FileSelectionPlan<F extends { name: string; type: string; size: number }> {
  accepted: F[];
  error: string | null;
}

/**
 * Decide which picked files can be added and what (if anything) to tell the
 * user about the rest.
 */
export function planFileSelection<F extends { name: string; type: string; size: number }>(
  incoming: F[],
  alreadySelected: number,
): FileSelectionPlan<F> {
  const tooLarge = incoming.filter((f) => f.size > MAX_SIZE);
  const unsupported = incoming.filter((f) => f.size <= MAX_SIZE && !fileContentType(f));
  const empty = incoming.filter((f) => f.size === 0 && fileContentType(f));
  const valid = incoming.filter((f) => fileContentType(f) && f.size > 0 && f.size <= MAX_SIZE);
  const remaining = Math.max(0, MAX_FILES - alreadySelected);
  const accepted = valid.slice(0, remaining);
  const overLimit = valid.length - accepted.length;

  // An oversize file is always reported (as before). The other rejections are
  // reported when nothing could be added, so a pick never silently does
  // nothing, without blocking Send when some files were added.
  let error: string | null = null;
  if (tooLarge.length === 1) {
    error = `${tooLarge[0].name} is larger than 1 GB and cannot be sent.`;
  } else if (tooLarge.length > 1) {
    error = `${tooLarge.length} files are larger than 1 GB and cannot be sent.`;
  } else if (accepted.length > 0) {
    error = null;
  } else if (unsupported.length === 1) {
    error = `${unsupported[0].name} can't be sent. Use PDF, DOCX, XLSX, PNG, or JPG.`;
  } else if (unsupported.length > 1) {
    error = `${unsupported.length} files can't be sent. Use PDF, DOCX, XLSX, PNG, or JPG.`;
  } else if (empty.length === 1) {
    error = `${empty[0].name} is empty and cannot be sent.`;
  } else if (empty.length > 1) {
    error = `${empty.length} files are empty and cannot be sent.`;
  } else if (overLimit > 0) {
    error = `You can send up to ${MAX_FILES} files at a time.`;
  }

  return { accepted, error };
}

/** Immutably apply a status/hash update to one selected file. */
export function applyFileUpdate(
  files: SelectedFile[],
  id: string,
  patch: Partial<Omit<SelectedFile, 'id' | 'file'>>,
): SelectedFile[] {
  let changed = false;
  const next = files.map((f) => {
    if (f.id !== id) return f;
    changed = true;
    return { ...f, ...patch };
  });
  return changed ? next : files;
}
