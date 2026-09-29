/** Small formatting helpers shared across features. */

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function mmss(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function dayLabel(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/*
 * Binary helpers used by the private-messaging crypto layer.
 *
 * `btoa`/`atob` are chunked rather than spread with `String.fromCharCode(...bytes)`: a message body
 * can run to thousands of bytes, and the spread form throws a stack overflow well before that on
 * mobile Safari.
 */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

export function utf8Decode(value: ArrayBuffer | Uint8Array): string {
  return new TextDecoder().decode(value instanceof Uint8Array ? value : new Uint8Array(value));
}

/** Strips markdown so text can be read aloud or previewed cleanly. */
export function plainText(markdown: string, limit = 1200): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/>\s?/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, limit);
}

export function difficultyTone(difficulty: string): 'success' | 'warning' | 'error' | 'muted' {
  if (difficulty === 'easy') return 'success';
  if (difficulty === 'medium') return 'warning';
  if (difficulty === 'hard') return 'error';
  return 'muted';
}

export function scoreTone(ratio: number): 'success' | 'warning' | 'error' {
  if (ratio >= 0.8) return 'success';
  if (ratio >= 0.5) return 'warning';
  return 'error';
}
