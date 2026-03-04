import { FileScanner } from "@/components/domain/file-scanner";
import { FileList } from "@/components/domain/file-list";
import { StatsCards } from "@/components/domain/stats-cards";
import { BatchActions } from "@/components/domain/batch-actions";

export default function ScannerPage() {
  return (
    <>
      {/* Sticky header */}
      <div className="sticky top-0 z-40 min-h-[56px] md:h-16 flex flex-col md:flex-row md:items-center justify-between px-4 md:px-8 pl-14 md:pl-8 py-2 md:py-0 gap-2 md:gap-0 border-b border-border-dark bg-background-dark/80 backdrop-blur-sm">
        <div>
          <h1 className="text-base md:text-lg font-bold text-zinc-100">스캐너</h1>
          <p className="text-xs text-zinc-500">
            영화 파일을 관리하고 정리하세요
          </p>
        </div>
        <BatchActions />
      </div>

      {/* Content */}
      <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-7xl mx-auto w-full">
        <FileScanner />
        <FileList />
        <StatsCards />
      </div>
    </>
  );
}
