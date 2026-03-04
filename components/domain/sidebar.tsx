"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Film, ScanSearch, LayoutGrid, Settings, FolderOpen, Menu, X, Languages } from "lucide-react";

const navItems = [
  { href: "/", label: "스캐너", icon: ScanSearch },
  { href: "/files", label: "파일 관리자", icon: FolderOpen },
  { href: "/library", label: "라이브러리", icon: LayoutGrid },
  { href: "/translate", label: "자막 번역", icon: Languages },
  { href: "/settings", label: "설정", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-3 left-3 z-50 p-2 rounded-lg bg-surface-dark/90 border border-border-dark text-zinc-400 hover:text-zinc-200 md:hidden backdrop-blur-sm"
        aria-label="메뉴 열기"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`w-64 bg-surface-dark border-r border-border-dark flex flex-col fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        } md:translate-x-0`}
      >
        {/* Mobile close button */}
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-3 right-3 p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors md:hidden"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Logo */}
        <div className="h-16 flex items-center px-6 border-b border-border-dark">
          <Link
            href="/"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2 text-primary font-bold text-lg tracking-tight"
          >
            <Film className="w-6 h-6" />
            <span>Renamer</span>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-6 space-y-1">
          {navItems.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                }`}
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User */}
        <div className="p-4 border-t border-border-dark">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-primary to-emerald-300 flex items-center justify-center text-white text-xs font-bold">
              MR
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-zinc-200">
                Movie Renamer
              </span>
              <span className="text-[10px] text-zinc-500">v1.0.0</span>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
