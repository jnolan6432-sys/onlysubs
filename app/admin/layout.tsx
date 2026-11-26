import Link from "next/link";
import { requireAdminPage } from "@/lib/admin";
import { AdminDropdown } from "./ui/admin-dropdown";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireAdminPage();

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <Link className="font-semibold tracking-wide text-teal-800" href="/">
            OnlySubs
          </Link>
          <AdminDropdown />
        </div>
      </header>
      {children}
    </>
  );
}
