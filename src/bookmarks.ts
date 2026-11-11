import type { XReference } from './document';
import { normalizeXUrl } from './x-post.ts';

export const BOOKMARKS_KEY = 'between.bookmarks.v1';
export type Bookmark = { id: string; savedAt: number; reference: XReference };
export type BookmarkLoad = { items: Bookmark[]; raw: string | null; blocked: boolean };
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;

export function readBookmarks(storage: StorageAccess): BookmarkLoad {
  let raw: string | null = null;
  try {
    raw = storage.getItem(BOOKMARKS_KEY);
    if (raw === null) return { items: [], raw, blocked: false };
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items) || items.length > 1000) throw new Error();
    const ids = new Set<string>();
    for (const item of items) {
      const ref = item?.reference;
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        !Number.isFinite(item.savedAt) || !ref || typeof ref.text !== 'string' ||
        ref.text.length > 60_000 || typeof ref.url !== 'string' ||
        (!ref.text.trim() && !ref.url) || typeof ref.authorName !== 'string' || ref.authorName.length > 200 ||
        !['manual', 'x'].includes(ref.source)) throw new Error();
      if (ref.url && normalizeXUrl(ref.url) !== ref.url) throw new Error();
      if (ref.note !== undefined && typeof ref.note !== 'string') throw new Error();
      if (ref.authorHandle !== undefined && typeof ref.authorHandle !== 'string') throw new Error();
      ids.add(item.id);
    }
    return { items: items as Bookmark[], raw, blocked: false };
  } catch { return { items: [], raw, blocked: true }; }
}

// Never replace unreadable data or another tab's newer collection.
export function writeBookmarks(storage: StorageAccess, state: BookmarkLoad, items: Bookmark[]): BookmarkLoad {
  if (state.blocked) throw new Error('Bookmark saving is paused to protect unreadable data.');
  if (storage.getItem(BOOKMARKS_KEY) !== state.raw) throw new Error('Bookmarks changed in another tab. Reload before saving.');
  if (items.length > 1000) throw new Error('You have reached 1,000 bookmarks. Remove one before adding another.');
  const raw = JSON.stringify(items);
  const verified = readBookmarks({ getItem: () => raw, setItem: () => {} });
  if (verified.blocked) throw new Error('This bookmark could not be saved. Check its link and text.');
  storage.setItem(BOOKMARKS_KEY, raw);
  return { items, raw, blocked: false };
}
