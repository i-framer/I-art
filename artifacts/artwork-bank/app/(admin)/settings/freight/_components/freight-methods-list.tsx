"use client";

import { useState } from "react";
import { Pencil, Trash2, CheckCircle2, XCircle } from "lucide-react";
import type { FreightMethod } from "@workspace/db";
import { FreightMethodForm } from "./freight-method-form";
import { deleteFreightMethod } from "../actions";

function centsToAud(cents: number): string {
  return (cents / 100).toFixed(2);
}

function MethodRow({ method }: { method: FreightMethod }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-4">
        <p className="text-sm font-medium text-stone-700 mb-3">
          Edit &ldquo;{method.name}&rdquo;
        </p>
        <FreightMethodForm
          mode="edit"
          method={method}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {method.enabled ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 text-stone-400 shrink-0" />
          )}
          <span className="text-sm font-medium text-stone-900">{method.name}</span>
          {!method.enabled && (
            <span className="text-xs text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded">
              disabled
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-stone-200 p-1.5 text-stone-500 hover:text-stone-700 hover:bg-stone-50 transition-colors"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <form action={deleteFreightMethod}>
            <input type="hidden" name="id" value={method.id} />
            <button
              type="submit"
              className="rounded-lg border border-red-200 p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors"
              title="Delete"
              onClick={(e) => {
                if (
                  !confirm(
                    `Delete "${method.name}"? This cannot be undone.`,
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </div>

      {/* Rate grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-xs text-stone-600">
        <div className="rounded-lg bg-stone-50 border border-stone-100 px-3 py-2">
          <div className="text-stone-400 font-medium mb-0.5">Small</div>
          <div className="font-mono text-stone-700">${centsToAud(method.smallCents)}</div>
        </div>
        <div className="rounded-lg bg-stone-50 border border-stone-100 px-3 py-2">
          <div className="text-stone-400 font-medium mb-0.5">Medium</div>
          <div className="font-mono text-stone-700">${centsToAud(method.mediumCents)}</div>
        </div>
        <div className="rounded-lg bg-stone-50 border border-stone-100 px-3 py-2">
          <div className="text-stone-400 font-medium mb-0.5">Large</div>
          <div className="font-mono text-stone-700">${centsToAud(method.largeCents)}</div>
        </div>
        <div className="rounded-lg bg-stone-50 border border-stone-100 px-3 py-2">
          <div className="text-stone-400 font-medium mb-0.5">Rolled tube</div>
          <div className="font-mono text-stone-700">${centsToAud(method.tubeCents)}</div>
        </div>
      </div>
    </div>
  );
}

export function FreightMethodsList({ methods }: { methods: FreightMethod[] }) {
  if (methods.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 px-6 py-10 text-center">
        <p className="text-sm font-medium text-stone-500">No freight methods yet</p>
        <p className="mt-1 text-xs text-stone-400">
          Add a method below to offer shipping options at checkout.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {methods.map((m) => (
        <MethodRow key={m.id} method={m} />
      ))}
    </div>
  );
}
