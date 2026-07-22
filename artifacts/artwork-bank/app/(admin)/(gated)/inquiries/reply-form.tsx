"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { replyToInquiry, type ReplyState } from "./actions";

function SendButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
    >
      {pending ? "Sending…" : "Send reply"}
    </button>
  );
}

export function ReplyForm({
  inquiryId,
  buyerName,
}: {
  inquiryId: string;
  buyerName: string;
}) {
  const [open, setOpen] = useState(false);
  const initial: ReplyState = { status: "idle" };
  const [state, formAction] = useActionState(replyToInquiry, initial);

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        {state.status === "sent" && (
          <span className="text-xs font-medium text-green-700">
            Reply sent
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
        >
          Reply
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-2 w-full">
      <input type="hidden" name="inquiryId" value={inquiryId} />
      <textarea
        name="replyMessage"
        required
        rows={4}
        maxLength={5000}
        placeholder={`Write your reply to ${buyerName}…`}
        className="w-full rounded-lg border border-stone-200 p-3 text-sm text-stone-900 focus:border-stone-400 focus:outline-none"
      />
      {state.status === "error" && (
        <p className="mt-1 text-xs font-medium text-red-700">
          {state.message ?? "Failed to send reply."}
        </p>
      )}
      {state.status === "sent" && (
        <p className="mt-1 text-xs font-medium text-green-700">
          Reply sent — inquiry marked as handled.
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <SendButton />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
