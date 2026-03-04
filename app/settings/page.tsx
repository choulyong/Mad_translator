import { getMovieCount } from "@/app/actions";
import { Film, Database, Info, Globe, Sparkles, Star, BookOpen } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const movieCount = await getMovieCount();
  const hasTmdbKey = !!process.env.TMDB_API_KEY && process.env.TMDB_API_KEY !== "your_tmdb_bearer_token_here";
  const hasOmdb = !!process.env.OMDB_API_KEY;
  const hasGemini = !!process.env.GCP_PROJECT_ID && !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

  return (
    <>
      {/* Header */}
      <header className="h-14 md:h-16 flex items-center justify-between px-4 md:px-8 pl-14 md:pl-8 border-b border-[#27272a] bg-[#09090b]/80 backdrop-blur sticky top-0 z-40">
        <div>
          <h1 className="text-lg md:text-xl font-semibold text-zinc-100">설정 및 상태</h1>
          <p className="text-xs text-zinc-500 mt-0.5 hidden sm:block">애플리케이션 설정을 관리하고 시스템 상태를 확인하세요.</p>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="max-w-6xl mx-auto space-y-6 md:space-y-8">
          {/* 3-column cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">

            {/* Card 1: API 설정 */}
            <div className="bg-[#18181b] border border-[#27272a] rounded-xl overflow-hidden flex flex-col">
              <div className="px-6 py-5 border-b border-[#27272a] flex justify-between items-center bg-[#121215]">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <Globe className="w-5 h-5 text-[#17cf5a]" />
                  API 설정
                </h3>
              </div>
              <div className="p-6 flex-1 space-y-6">
                {/* TMDB */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <Film className="w-5 h-5 text-blue-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-100">TMDB API</p>
                      <p className="text-xs text-zinc-500">영화 메타데이터 소스</p>
                    </div>
                  </div>
                  {hasTmdbKey ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#17cf5a]/20 text-[#17cf5a] border border-[#17cf5a]/20">
                      <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-[#17cf5a]" />연결됨
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">설정 안됨</span>
                  )}
                </div>
                {/* Vertex AI Gemini */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center">
                      <Sparkles className="w-5 h-5 text-purple-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-100">Vertex AI Gemini</p>
                      <p className="text-xs text-zinc-500">자동 번역 (Gemini Flash)</p>
                    </div>
                  </div>
                  {hasGemini ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#17cf5a]/20 text-[#17cf5a] border border-[#17cf5a]/20">
                      <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-[#17cf5a]" />연결됨
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">설정 안됨</span>
                  )}
                </div>
                {/* OMDb */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                      <Star className="w-5 h-5 text-yellow-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-100">OMDb API</p>
                      <p className="text-xs text-zinc-500">IMDb / RT / Metacritic</p>
                    </div>
                  </div>
                  {hasOmdb ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#17cf5a]/20 text-[#17cf5a] border border-[#17cf5a]/20">
                      <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-[#17cf5a]" />연결됨
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">설정 안됨</span>
                  )}
                </div>
                {/* Wikipedia */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-zinc-500/10 flex items-center justify-center">
                      <BookOpen className="w-5 h-5 text-zinc-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-zinc-100">Wikipedia</p>
                      <p className="text-xs text-zinc-500">한국어 줄거리 (API 키 불필요)</p>
                    </div>
                  </div>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[#17cf5a]/20 text-[#17cf5a] border border-[#17cf5a]/20">
                    <span className="w-1.5 h-1.5 mr-1.5 rounded-full bg-[#17cf5a]" />사용 가능
                  </span>
                </div>
              </div>
            </div>

            {/* Card 2: 데이터베이스 */}
            <div className="bg-[#18181b] border border-[#27272a] rounded-xl overflow-hidden flex flex-col">
              <div className="px-6 py-5 border-b border-[#27272a] flex justify-between items-center bg-[#121215]">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <Database className="w-5 h-5 text-[#17cf5a]" />
                  데이터베이스
                </h3>
              </div>
              <div className="p-6 flex-1 flex flex-col justify-center">
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-[#121215] rounded-lg p-4 border border-[#27272a]/50">
                    <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-1">SQLite 상태</p>
                    <div className="flex items-center gap-2">
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#17cf5a] opacity-75" />
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-[#17cf5a]" />
                      </span>
                      <span className="text-lg font-bold text-white">활성</span>
                    </div>
                  </div>
                  <div className="bg-[#121215] rounded-lg p-4 border border-[#27272a]/50">
                    <p className="text-xs text-zinc-500 uppercase tracking-wide font-medium mb-1">총 영화 수</p>
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-zinc-400" />
                      <span className="text-lg font-bold text-white">{movieCount}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 3: 정보 */}
            <div className="bg-[#18181b] border border-[#27272a] rounded-xl overflow-hidden flex flex-col">
              <div className="px-6 py-5 border-b border-[#27272a] flex justify-between items-center bg-[#121215]">
                <h3 className="text-base font-semibold text-white flex items-center gap-2">
                  <Info className="w-5 h-5 text-[#17cf5a]" />
                  정보
                </h3>
              </div>
              <div className="p-6 flex-1 flex flex-col items-center text-center justify-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#17cf5a] to-green-700 flex items-center justify-center mb-4 shadow-lg shadow-[#17cf5a]/20">
                  <Film className="w-8 h-8 text-white" />
                </div>
                <h4 className="text-lg font-bold text-white mb-1">Movie Renamer</h4>
                <p className="text-sm text-zinc-500 mb-4">버전 1.0.0</p>
                <p className="text-sm text-zinc-400 mb-6 max-w-[200px]">
                  영화 컬렉션을 자동으로 정리해주는 간단하고 강력한 도구입니다.
                </p>
              </div>
            </div>
          </div>

          {/* 이름 지정 형식 */}
          <div>
            <h2 className="text-lg font-medium text-white mb-4">이름 지정 형식</h2>
            <div className="bg-[#18181b] border border-[#27272a] rounded-xl p-6">
              <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">패턴</label>
                  <div className="font-mono text-sm bg-[#121215] px-3 py-2 rounded border border-[#27272a] text-zinc-400">
                    {"{Title} ({Year}).{Ext}"}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Film className="w-4 h-4" />
                  <span>미리보기: <span className="text-white font-medium">인셉션 (2010).mkv</span></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
