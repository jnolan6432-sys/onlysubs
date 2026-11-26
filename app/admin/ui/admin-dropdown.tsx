"use client";

import Link from "next/link";

export function AdminDropdown() {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
        Admin menu
        <span aria-hidden="true" className="ml-2 text-xs">
          ▾
        </span>
      </summary>
      <div className="absolute right-0 mt-2 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
        <Link
          className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
          href="/admin/seasons/new"
        >
          Build New Season
        </Link>
        <Link
          className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
          href="/admin/seasons"
        >
          Manage Seasons
        </Link>
      </div>
    </details>
  );
}
