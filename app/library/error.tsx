"use client";

import { AlertCircle } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-center">
      <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
      <h2 className="text-lg font-semibold text-zinc-300 mb-2">
        라이브러리를 불러오지 못했습니다
      </h2>
      <p className="text-sm text-zinc-500 mb-6">
        {error.message || "알 수 없는 오류가 발생했습니다"}
      </p>
      <button
        onClick={reset}
        className="px-4 py-2 rounded-lg bg-primary/10 text-primary text-sm font-medium border border-primary/20 hover:bg-primary/20 transition-colors"
      >
        다시 시도
      </button>
    </div>
  );
}
