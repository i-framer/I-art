"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import {
  createInvite,
  removeTeamMember,
  type InviteResultState,
} from "@/app/(admin)/settings/actions";
import { Users, UserPlus, Copy, Check, Trash2, CreditCard } from "lucide-react";

const initialState: InviteResultState = {
  error: "",
  success: false,
  inviteUrl: "",
  email: "",
};

function InviteForm({ isOwner }: { isOwner: boolean }) {
  const [state, formAction, isPending] = useActionState<
    InviteResultState,
    FormData
  >(createInvite, initialState);
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    if (!state.inviteUrl) return;
    const fullUrl = window.location.origin + state.inviteUrl;
    await navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isOwner) {
    return (
      <p className="text-sm text-stone-500">
        Only owners can invite team members.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {state.success && state.inviteUrl && (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4">
          <p className="text-sm font-medium text-emerald-800 mb-2">
            Invite link created for {state.email}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-emerald-200 rounded px-2.5 py-2 text-emerald-700 truncate">
              {typeof window !== "undefined"
                ? window.location.origin + state.inviteUrl
                : state.inviteUrl}
            </code>
            <button
              type="button"
              onClick={copyLink}
              className="flex items-center gap-1.5 shrink-0 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50 transition-colors"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-emerald-600 mt-2">
            Share this link with your team member. It expires in 7 days.
          </p>
        </div>
      )}

      {state.error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      )}

      <form action={formAction} className="flex items-end gap-3">
        <div className="flex-1">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-stone-700 mb-1.5"
          >
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
            placeholder="colleague@example.com"
          />
        </div>
        <div>
          <label
            htmlFor="role"
            className="block text-sm font-medium text-stone-700 mb-1.5"
          >
            Role
          </label>
          <select
            id="role"
            name="role"
            className="rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
          >
            <option value="staff">Staff</option>
            <option value="owner">Owner</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2 disabled:opacity-50 transition-colors"
        >
          <UserPlus className="h-4 w-4" />
          {isPending ? "Sending…" : "Invite"}
        </button>
      </form>
    </div>
  );
}

export default function TeamPageClient({
  members,
  currentUserId,
  isOwner,
}: {
  members: Array<{ userId: string; role: string; email: string }>;
  currentUserId: string;
  isOwner: boolean;
}) {
  return (
    <div className="px-8 py-8 max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-stone-900">Settings</h1>
        <p className="text-stone-500 mt-1">
          Manage your storefront details and preferences.
        </p>
      </div>

      {/* Tab-like nav */}
      <div className="flex gap-1 mb-8 border-b border-stone-200">
        <Link
          href="/settings"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors"
        >
          General
        </Link>
        <Link
          href="/settings/team"
          className="px-4 py-2.5 text-sm font-medium text-stone-900 border-b-2 border-stone-900 -mb-px flex items-center gap-1.5"
        >
          <Users className="h-3.5 w-3.5" />
          Team
        </Link>
        <Link
          href="/settings/billing"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          <CreditCard className="h-3.5 w-3.5" />
          Billing
        </Link>
        <Link
          href="/settings/freight"
          className="px-4 py-2.5 text-sm font-medium text-stone-500 hover:text-stone-700 transition-colors flex items-center gap-1.5"
        >
          Freight
        </Link>
      </div>

      {/* Current members */}
      <div className="rounded-xl border border-stone-200 bg-white p-6 mb-6">
        <h2 className="text-sm font-semibold text-stone-900 mb-4">
          Team members ({members.length})
        </h2>
        <div className="space-y-2">
          {members.map((member) => (
            <div
              key={member.userId}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-stone-50 group"
            >
              <div className="h-8 w-8 rounded-full bg-stone-200 flex items-center justify-center shrink-0">
                <span className="text-xs font-semibold text-stone-600 uppercase">
                  {member.email.charAt(0)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-stone-900 truncate">
                  {member.email}
                  {member.userId === currentUserId && (
                    <span className="ml-1.5 text-xs text-stone-400">(you)</span>
                  )}
                </p>
              </div>
              <span className="text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full font-medium capitalize">
                {member.role}
              </span>
              {isOwner && member.userId !== currentUserId && (
                <form action={removeTeamMember.bind(null, member.userId)}>
                  <button
                    type="submit"
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-stone-400 hover:text-red-500 hover:bg-red-50 transition-all"
                    title="Remove member"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Invite form */}
      <div className="rounded-xl border border-stone-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-stone-900 mb-4">
          Invite a team member
        </h2>
        <InviteForm isOwner={isOwner} />
      </div>
    </div>
  );
}
