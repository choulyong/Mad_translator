"use client";

import Image from "next/image";
import { Film, Star, Trash2, Subtitles } from "lucide-react";
import type { Movie } from "@/lib/db/schema";

interface SubInfo { language: "ko" | "en" | "unknown" }

interface MovieCardProps {
  movie: Movie;
  onClick: (movie: Movie) => void;
  onDelete?: (id: string) => void;
}

export function MovieCard({ movie, onClick, onDelete }: MovieCardProps) {
  const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : null;
  const genres: string[] = movie.genres ? JSON.parse(movie.genres) : [];
  const subs: SubInfo[] = movie.subtitleFiles ? JSON.parse(movie.subtitleFiles) : [];
  const hasKo = subs.some(s => s.language === "ko");
  const hasEn = subs.some(s => s.language === "en");
  const hasSub = subs.length > 0;

  return (
    <div
      className="group cursor-pointer flex flex-col gap-2"
      onClick={() => onClick(movie)}
    >
      {/* Poster */}
      <div className="aspect-[2/3] w-full rounded-xl overflow-hidden relative bg-surface-dark border border-zinc-800 group-hover:border-primary/50 transition-all duration-300">
        {movie.posterPath ? (
          <Image
            src={`https://image.tmdb.org/t/p/w342${movie.posterPath}`}
            alt={movie.title}
            fill
            sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 20vw"
            className="object-cover group-hover:scale-105 transition-transform duration-500 opacity-90 group-hover:opacity-100"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-zinc-900">
            <Film className="w-10 h-10 text-zinc-700" />
          </div>
        )}
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

        {/* Subtitle badge (top-left) */}
        {hasSub && (
          <div className="absolute top-2 left-2 flex items-center gap-1">
            {hasKo && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-500/90 text-white leading-none flex items-center gap-0.5">
                <Subtitles className="w-3 h-3" />한
              </span>
            )}
            {hasEn && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/90 text-white leading-none flex items-center gap-0.5">
                <Subtitles className="w-3 h-3" />EN
              </span>
            )}
            {!hasKo && !hasEn && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-600/90 text-white leading-none flex items-center gap-0.5">
                <Subtitles className="w-3 h-3" />자막
              </span>
            )}
          </div>
        )}

        {/* Rating badges (bottom-left, always visible) */}
        <div className="absolute bottom-2 left-2 flex items-center gap-1">
          {movie.imdbRating && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/90 text-black leading-none">
              IMDb {movie.imdbRating}
            </span>
          )}
          {movie.rottenTomatoes && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-600/90 text-white leading-none">
              {movie.rottenTomatoes}
            </span>
          )}
        </div>

        {/* Delete button on hover */}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(movie.id);
            }}
            className="absolute top-2 right-2 p-2 md:p-1.5 rounded-lg bg-black/60 text-zinc-400 hover:text-red-400 hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-all duration-200 z-10"
            title="삭제"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Info */}
      <div className="px-1">
        <h3 className="font-semibold text-xs md:text-sm text-zinc-200 truncate group-hover:text-white transition-colors">
          {movie.title}
        </h3>
        <div className="flex items-center gap-2 mt-0.5">
          {year && (
            <span className="text-xs text-zinc-500">
              {year}
            </span>
          )}
          {movie.rating && (
            <span className="inline-flex items-center gap-0.5 text-xs text-amber-400/80">
              <Star className="w-3 h-3" />
              {Number(movie.rating).toFixed(1)}
            </span>
          )}
          {genres.length > 0 && (
            <span className="text-[10px] text-zinc-600 truncate">
              {genres.slice(0, 2).join(" / ")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
