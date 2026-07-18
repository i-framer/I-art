"use client";

import { useActionState, useState } from "react";
import {
  createRepresentedArtist,
  updateRepresentedArtist,
  deleteRepresentedArtist,
  type ArtistState,
} from "./actions";
import { Plus, Pencil, Trash2, X, Check, Loader2 } from "lucide-react";

type Artist = {
  id: string;
  name: string;
  bio: string | null;
  commissionPct: number;
  artworkCount: number;
};

const initialState: ArtistState = { error: "" };

const inputCls =
  "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10";

function AddArtistForm({ onAdded }: { onAdded: () => void }) {
  const [state, formAction, isPending] = useActionState<ArtistState, FormData>(
    async (prev, fd) => {
      const result = await createRepresentedArtist(prev, fd);
      if (result.success) onAdded();
      return result;
    },
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <p className="text-sm text-red-600">{state.error}</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 sm:col-span-1">
          <label className="block text-xs font-medium text-stone-600 mb-1">Name *</label>
          <input name="name" type="text" required placeholder="Artist name" className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-stone-600 mb-1">Commission %</label>
          <input
            name="commissionPct"
            type="number"
            min="0"
            max="100"
            defaultValue="0"
            className={inputCls}
          />
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-stone-600 mb-1">Bio</label>
        <textarea name="bio" rows={2} placeholder="Short bio (optional)" className={inputCls} />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50 transition-colors"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Add artist
      </button>
    </form>
  );
}

function EditArtistForm({
  artist,
  onDone,
}: {
  artist: Artist;
  onDone: (updated: Partial<Artist>) => void;
}) {
  const [state, formAction, isPending] = useActionState<ArtistState, FormData>(
    async (prev, fd) => {
      const result = await updateRepresentedArtist(artist.id, prev, fd);
      if (result.success) {
        onDone({
          name: fd.get("name") as string,
          bio: (fd.get("bio") as string) || null,
          commissionPct: parseInt(fd.get("commissionPct") as string) || 0,
        });
      }
      return result;
    },
    initialState,
  );

  return (
    <form action={formAction} className="space-y-3 mt-2 p-3 bg-stone-50 rounded-lg">
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <input
            name="name"
            type="text"
            defaultValue={artist.name}
            required
            className={inputCls}
            placeholder="Name"
          />
        </div>
        <div>
          <div className="relative">
            <input
              name="commissionPct"
              type="number"
              min="0"
              max="100"
              defaultValue={artist.commissionPct}
              className={`${inputCls} pr-7`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 text-sm">%</span>
          </div>
        </div>
      </div>
      <textarea
        name="bio"
        rows={2}
        defaultValue={artist.bio ?? ""}
        className={inputCls}
        placeholder="Bio (optional)"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Save
        </button>
        <button
          type="button"
          onClick={() => onDone({})}
          className="flex items-center gap-1.5 rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-50"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ArtistsClient({ initialArtists }: { initialArtists: Artist[] }) {
  const [artists, setArtists] = useState<Artist[]>(initialArtists);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [showAdd, setShowAdd] = useState(artists.length === 0);

  async function handleDelete(id: string) {
    if (!confirm("Remove this artist? This cannot be undone.")) return;
    const result = await deleteRepresentedArtist(id);
    if (result.error) {
      setDeleteErrors((prev) => ({ ...prev, [id]: result.error }));
    } else {
      setArtists((prev) => prev.filter((a) => a.id !== id));
    }
  }

  return (
    <div className="space-y-4">
      {/* Artist list */}
      {artists.length > 0 && (
        <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
          <ul className="divide-y divide-stone-100">
            {artists.map((artist) => (
              <li key={artist.id} className="p-5">
                {editingId === artist.id ? (
                  <EditArtistForm
                    artist={artist}
                    onDone={(updated) => {
                      if (Object.keys(updated).length > 0) {
                        setArtists((prev) =>
                          prev.map((a) => (a.id === artist.id ? { ...a, ...updated } : a)),
                        );
                      }
                      setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="flex items-start gap-3 group">
                    <div className="h-9 w-9 rounded-full bg-stone-200 flex items-center justify-center shrink-0">
                      <span className="text-sm font-semibold text-stone-600 uppercase">
                        {artist.name.charAt(0)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-stone-900">{artist.name}</p>
                        <span className="text-xs bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded">
                          {artist.commissionPct}% commission
                        </span>
                      </div>
                      {artist.bio && (
                        <p className="text-xs text-stone-500 mt-0.5 line-clamp-2">{artist.bio}</p>
                      )}
                      <p className="text-xs text-stone-400 mt-1">
                        {artist.artworkCount} artwork{artist.artworkCount !== 1 ? "s" : ""} linked
                      </p>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        onClick={() => setEditingId(artist.id)}
                        className="rounded p-1.5 text-stone-400 hover:text-stone-900 hover:bg-stone-100"
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(artist.id)}
                        className="rounded p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
                {deleteErrors[artist.id] && (
                  <p className="text-xs text-red-600 mt-2">{deleteErrors[artist.id]}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add form */}
      {showAdd ? (
        <div className="rounded-xl border border-stone-200 bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-stone-900">Add artist</h2>
            {artists.length > 0 && (
              <button type="button" onClick={() => setShowAdd(false)} className="text-stone-400 hover:text-stone-600">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <AddArtistForm onAdded={() => window.location.reload()} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 rounded-lg border border-stone-300 border-dashed px-4 py-3 text-sm text-stone-500 hover:border-stone-400 hover:text-stone-700 transition-colors w-full justify-center"
        >
          <Plus className="h-4 w-4" />
          Add represented artist
        </button>
      )}
    </div>
  );
}
