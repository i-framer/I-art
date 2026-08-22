import Link from "next/link";
import { ShieldCheck, Users, BarChart3, Truck } from "lucide-react";

export interface PlatformAdminHeaderProps {
  title: string;
  email: string;
  activeSection: "tenants" | "reports" | "couriers";
}

export function PlatformAdminHeader({
  title,
  email,
  activeSection,
}: PlatformAdminHeaderProps) {
  return (
    <header className="bg-stone-900 px-4 sm:px-6 border-b border-stone-800">
      <div className="mx-auto flex max-w-6xl flex-col sm:flex-row sm:h-16 sm:items-center sm:justify-between py-4 sm:py-0 gap-4 sm:gap-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="h-5 w-5 text-amber-400 shrink-0" />
            <h1 className="text-sm font-semibold text-white line-clamp-1">
              {title}
            </h1>
          </div>
          <span className="text-xs text-stone-400 sm:hidden truncate ml-4">
            {email}
          </span>
        </div>

        <div className="flex items-center gap-4 sm:gap-6">
          <nav className="flex items-center gap-1 -ml-2 sm:ml-0 overflow-x-auto pb-1 sm:pb-0" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            <Link
              href="/platform"
              className={`group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${
                activeSection === "tenants"
                  ? "bg-stone-800 text-white"
                  : "text-stone-400 hover:bg-stone-800 hover:text-stone-100"
              }`}
            >
              <Users
                className={`h-4 w-4 ${
                  activeSection === "tenants"
                    ? "text-amber-400"
                    : "text-stone-500 group-hover:text-stone-400"
                }`}
              />
              Tenants
            </Link>
            <Link
              href="/platform/reports"
              className={`group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${
                activeSection === "reports"
                  ? "bg-stone-800 text-white"
                  : "text-stone-400 hover:bg-stone-800 hover:text-stone-100"
              }`}
            >
              <BarChart3
                className={`h-4 w-4 ${
                  activeSection === "reports"
                    ? "text-amber-400"
                    : "text-stone-500 group-hover:text-stone-400"
                }`}
              />
              Reports
            </Link>
            <Link
              href="/platform/couriers"
              className={`group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-900 ${
                activeSection === "couriers"
                  ? "bg-stone-800 text-white"
                  : "text-stone-400 hover:bg-stone-800 hover:text-stone-100"
              }`}
            >
              <Truck
                className={`h-4 w-4 ${
                  activeSection === "couriers"
                    ? "text-amber-400"
                    : "text-stone-500 group-hover:text-stone-400"
                }`}
              />
              Couriers
            </Link>
          </nav>

          <div className="hidden h-4 w-px bg-stone-700 sm:block"></div>

          <span className="hidden text-xs text-stone-400 sm:block truncate max-w-[200px]">
            {email}
          </span>
        </div>
      </div>
    </header>
  );
}
