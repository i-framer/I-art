"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

interface ContactEmailFieldProps {
  defaultValue: string;
  pendingNoContactInquiries: number;
}

export function ContactEmailField({
  defaultValue,
  pendingNoContactInquiries,
}: ContactEmailFieldProps) {
  const [value, setValue] = useState(defaultValue);

  const showWarning = pendingNoContactInquiries > 0 && value.trim() === "";

  return (
    <div>
      <label
        htmlFor="contactEmail"
        className="block text-sm font-medium text-stone-700 mb-1.5"
      >
        Contact email
      </label>
      <input
        id="contactEmail"
        name="contactEmail"
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="hello@yourgallery.com"
        className="w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-900/10 transition-colors"
      />
      <p className="mt-1 text-xs text-stone-400">
        Buyer inquiries are sent here when online payments are unavailable.
      </p>
      {showWarning && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-amber-800">
            <strong>
              {pendingNoContactInquiries === 1
                ? "1 pending inquiry"
                : `${pendingNoContactInquiries} pending inquiries`}
            </strong>{" "}
            {pendingNoContactInquiries === 1 ? "is" : "are"} waiting for a
            contact email to be delivered. Clearing this field will stall{" "}
            {pendingNoContactInquiries === 1 ? "it" : "them"} until an email is
            added back.
          </p>
        </div>
      )}
    </div>
  );
}
