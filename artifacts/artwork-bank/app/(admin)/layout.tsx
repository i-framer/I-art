import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { logout } from "@/app/(auth)/actions";
import { db } from "@workspace/db";
import { inquiriesTable, tenantsTable } from "@workspace/db";
import { eq, and, count, isNull } from "drizzle-orm";
import {
  LayoutDashboard,
  Image,
  ShoppingBag,
  MessageSquare,
  Settings,
  LogOut,
  Palette,
  Award,
  Handshake,
  GalleryVertical,
  Home,
} from "lucide-react";
import { InquiryBadge } from "@/app/(admin)/_components/inquiry-badge";

const navItems = [
  { href: "/admin", label: "Admin home", icon: Home },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/catalog", label: "Catalog", icon: Image },
  { href: "/orders", label: "Orders", icon: ShoppingBag },
  { href: "/inquiries", label: "Inquiries", icon: MessageSquare },
  { href: "/certificates", label: "Certificates", icon: Award },
  { href: "/exhibitions", label: "Exhibitions", icon: GalleryVertical },
  { href: "/consignment", label: "Consignment", icon: Handshake },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session.userId) {
    redirect("/login");
  }

  const [tenant, [newInquiriesRow]] = await Promise.all([
    db.query.tenantsTable.findFirst({
      where: eq(tenantsTable.id, session.tenantId),
    }),
    db
      .select({ count: count() })
      .from(inquiriesTable)
      .where(
        and(
          eq(inquiriesTable.tenantId, session.tenantId),
          eq(inquiriesTable.status, "NEW"),
          isNull(inquiriesTable.archivedAt),
        ),
      ),
  ]);

  const newInquiries = newInquiriesRow?.count ?? 0;

  if (!tenant) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen bg-stone-50">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-stone-900">
        {/* Logo */}
        <div className="flex h-16 items-center gap-2.5 px-5 border-b border-stone-800">
          <Palette className="h-5 w-5 text-amber-400 shrink-0" />
          <span className="text-sm font-semibold text-white truncate">
            Artwork Bank
          </span>
        </div>

        {/* Tenant badge */}
        <div className="px-4 py-3 border-b border-stone-800">
          <p className="text-xs text-stone-500 uppercase tracking-wider mb-1">
            Storefront
          </p>
          <p className="text-sm font-medium text-stone-100 truncate">
            {tenant.businessName}
          </p>
          <span className="inline-flex items-center mt-1 rounded-full bg-stone-800 px-2 py-0.5 text-[10px] font-medium text-stone-400">
            {tenant.type}
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-stone-300 hover:bg-stone-800 hover:text-white transition-colors"
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1">{label}</span>
              {href === "/inquiries" && (
                <InquiryBadge initialCount={newInquiries} />
              )}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-stone-800 px-4 py-3">
          <p className="text-xs text-stone-500 truncate mb-2">
            {session.email}
          </p>
          <form action={logout}>
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-stone-400 hover:bg-stone-800 hover:text-white transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 pl-60">
        <main className="min-h-screen">{children}</main>
      </div>
    </div>
  );
}
