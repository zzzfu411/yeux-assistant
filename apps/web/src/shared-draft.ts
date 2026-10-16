import { useEffect, useRef, useState } from 'react';
import type { ComposeDraft as ServerDraft, ComposeDraftContent } from '../../../packages/contracts/src/drafts';
import { ApiError, storage, useApi, useData } from './api';

type Known = { revision: number; content: ComposeDraftContent | null };
const SEEN = 'draft.compose.seen';
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function stored(): Known {
  try {
    const value = JSON.parse(storage.get(SEEN) || 'null');
    if (value && Number.isInteger(value.revision)) return value;
  } catch {
    /* Start as a device that has seen nothing. */
  }
  return { revision: 0, content: null };
}

/**
 * Keeps the unsent Today entry on the server so it follows the owner between phone and computer.
 * The browser copy stays the working copy (and the only one if the server cannot keep drafts); it is
 * saved 0.8 s after typing stops. A different version saved on another device is adopted only if
 * nothing here was changed since; otherwise it is offered, and the owner decides.
 */
export function useSharedDraft(
  draft: ComposeDraftContent,
  setDraft: (next: ComposeDraftContent) => void,
  empty: ComposeDraftContent,
) {
  const api = useApi(),
    server = useData<ServerDraft>('/drafts/compose'),
    known = useRef<Known>(stored()),
    current = useRef(draft),
    [offer, setOffer] = useState<ServerDraft | null>(null);
  current.current = draft;
  const available = server.isSuccess;
  const remember = (value: Known) => {
    known.current = { revision: value.revision, content: value.content };
    storage.set(SEEN, JSON.stringify(known.current));
  };
  useEffect(() => {
    const remote = server.data;
    if (!remote || (remote.revision === known.current.revision && same(remote.content, known.current.content))) return;
    const local = current.current,
      untouched = !local.text.trim() || same(local, known.current.content ?? empty);
    if (same(remote.content ?? empty, local) || untouched) {
      if (!same(remote.content ?? empty, local)) setDraft(remote.content ?? empty);
      remember(remote);
      setOffer(null);
    } else setOffer(remote);
  }, [server.data]);
  useEffect(() => {
    if (!available || offer) return;
    const saved = known.current.content;
    if (same(draft, saved ?? empty) || (!draft.text.trim() && !saved)) return;
    const timer = setTimeout(async () => {
      try {
        remember(
          await api.write<ServerDraft>('/drafts/compose', { revision: known.current.revision, content: draft }, 'PUT'),
        );
      } catch (error) {
        // Another device saved first: read its version, which is then offered.
        if (error instanceof ApiError && error.status === 409) void server.refetch();
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, available, offer]);
  return {
    synced: available,
    offer,
    takeOffer() {
      if (!offer) return;
      setDraft(offer.content ?? empty);
      remember(offer);
      setOffer(null);
    },
    keepMine() {
      if (!offer) return;
      // Saving over it is now intended: the next autosave writes on top of the version just seen.
      remember({ revision: offer.revision, content: offer.content });
      setOffer(null);
    },
    /** After the entry was sent: forget it here and remove it on the server unless it changed since. */
    sent() {
      const revision = known.current.revision;
      remember({ revision: 0, content: null });
      if (available && revision) void api.write('/drafts/compose/clear', { revision }).catch(() => {});
    },
  };
}
