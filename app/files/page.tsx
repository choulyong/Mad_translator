import { FileManager } from "@/components/domain/file-manager";

export default function FilesPage() {
  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden">
      {/* Fixed header */}
      <div className="shrink-0 h-14 md:h-16 flex items-center px-4 md:px-8 pl-14 md:pl-8 border-b border-border-dark bg-background-dark/80 backdrop-blur-sm">
        <div>
          <h1 className="text-base md:text-lg font-bold text-zinc-100">파일 관리자</h1>
          <p className="text-xs text-zinc-500">
            파일 이동, 복사, 삭제, 이름변경
          </p>
        </div>
      </div>

      {/* File manager fills remaining height exactly */}
      <div className="flex-1 min-h-0">
        <FileManager />
      </div>
    </div>
  );
}
