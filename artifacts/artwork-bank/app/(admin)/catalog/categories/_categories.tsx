"use client";

import { useActionState, useState } from "react";
import {
  createCategory,
  renameCategory,
  deleteCategory,
  type CategoryState,
} from "./actions";
import { Plus, Pencil, Trash2, Check, X, Loader2 } from "lucide-react";

type Category = { id: string; name: string; artworkCount: number };
const initialState: CategoryState = { error: "" };

function AddCategoryForm({ onAdded }: { onAdded: (cat: Category) => void }) {
  const [state, formAction, isPending] = useActionState<CategoryState, FormData>(
    async (prev, fd) => {
      const result = await createCategory(prev, fd);
      if (result.success) {
        onAdded({ id: Date.now().toString(), name: fd.get("name") as string, artworkCount: 0 });
      }
      return result;
    },
    initialState,
  );
  return (
    <form action={formAction} className="flex gap-2">
      <input
        name="name"
        type="text"
        required
        placeholder="New category name…"
        className="flex-1 rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
      />
      <button
        type="submit"
        disabled={isPending}
        className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50 transition-colors"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Add
      </button>
      {state.error && (
        <p className="text-sm text-red-600 self-center ml-1">{state.error}</p>
      )}
    </form>
  );
}

export function CategoriesClient({
  initialCategories,
}: {
  initialCategories: Category[];
}) {
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [renameError, setRenameError] = useState("");
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string>>({});
  const [isRenaming, setIsRenaming] = useState(false);

  function startEdit(cat: Category) {
    setEditingId(cat.id);
    setEditName(cat.name);
    setRenameError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setRenameError("");
  }

  async function saveRename(id: string) {
    if (!editName.trim()) {
      setRenameError("Name is required.");
      return;
    }
    setIsRenaming(true);
    setRenameError("");
    const fd = new FormData();
    fd.append("name", editName.trim());
    const result = await renameCategory(id, initialState, fd);
    setIsRenaming(false);
    if (result.error) {
      setRenameError(result.error);
    } else {
      setCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, name: editName.trim() } : c)),
      );
      cancelEdit();
    }
  }

  async function handleDelete(id: string) {
    const result = await deleteCategory(id);
    if (result.error) {
      setDeleteErrors((prev) => ({ ...prev, [id]: result.error }));
    } else {
      setCategories((prev) => prev.filter((c) => c.id !== id));
      setDeleteErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  return (
    <div className="space-y-4">
      {/* Add form */}
      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-stone-900 mb-3">Add category</h2>
        <AddCategoryForm
          onAdded={() => window.location.reload()}
        />
      </div>

      {/* Category list */}
      <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
        {categories.length === 0 ? (
          <p className="text-sm text-stone-400 text-center py-8">
            No categories yet. Add one above.
          </p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {categories.map((cat) => (
              <li key={cat.id} className="px-5 py-3">
                {editingId === cat.id ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(cat.id);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        autoFocus
                        className="flex-1 rounded-lg border border-stone-300 px-3 py-1.5 text-sm focus:border-stone-900 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => saveRename(cat.id)}
                        disabled={isRenaming}
                        className="rounded p-1.5 text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"
                        title="Save"
                      >
                        {isRenaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded p-1.5 text-stone-400 hover:bg-stone-100"
                        title="Cancel"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {renameError && (
                      <p className="text-xs text-red-600">{renameError}</p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 group">
                    <span className="flex-1 text-sm font-medium text-stone-900">
                      {cat.name}
                    </span>
                    <span className="text-xs text-stone-400 tabular-nums">
                      {cat.artworkCount} artwork{cat.artworkCount !== 1 ? "s" : ""}
                    </span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => startEdit(cat)}
                        className="rounded p-1.5 text-stone-400 hover:text-stone-900 hover:bg-stone-100"
                        title="Rename"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(cat.id)}
                        className="rounded p-1.5 text-stone-400 hover:text-red-600 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
                {deleteErrors[cat.id] && (
                  <p className="text-xs text-red-600 mt-1">{deleteErrors[cat.id]}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
