"use client";
import React from 'react';
import { FileText, Wand2 } from 'lucide-react';
import type { SubtitleBlock } from '@/lib/store/translate-types';

interface SubtitleTableProps {
  subtitles: SubtitleBlock[];
  visibleSubtitles: {
    items: SubtitleBlock[];
    startIdx: number;
    totalHeight: number;
    offsetY: number;
  };
  activeSubtitleId: number | null;
  onSubtitleClick: (id: number) => void;
  onSubtitleEdit: (id: number, field: 'en' | 'ko', value: string) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  isDarkMode: boolean;
}

export function TranslateSubtitleTable({ 
  subtitles, visibleSubtitles, activeSubtitleId, 
  onSubtitleClick, onSubtitleEdit, onScroll, isDarkMode 
}: SubtitleTableProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-black/20 rounded-xl border border-[#283039] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#283039] bg-[#0d1117]/50">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-[#137fec]" />
          <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Subtitle Stream</span>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-bold text-gray-500">
          <span>TOTAL: {subtitles.length}</span>
          <span className="text-green-500/80">LIVE</span>
        </div>
      </div>

      <div 
        className="flex-1 overflow-y-auto custom-scrollbar relative"
        onScroll={onScroll}
      >
        <div style={{ height: `${visibleSubtitles.totalHeight}px` }} className="w-full">
          <div 
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${visibleSubtitles.offsetY}px)` }}
          >
            {visibleSubtitles.items.map((sub, idx) => {
              const globalIdx = visibleSubtitles.startIdx + idx;
              const isActive = activeSubtitleId === sub.id;
              
              return (
                <div 
                  key={sub.id}
                  onClick={() => onSubtitleClick(sub.id)}
                  className={`flex items-stretch border-b border-[#283039]/30 transition-all cursor-pointer group h-[60px] ${
                    isActive ? 'bg-[#137fec]/10 border-l-2 border-l-[#137fec]' : 'hover:bg-white/5'
                  }`}
                >
                  <div className="w-12 flex items-center justify-center text-[10px] font-mono text-gray-600 border-r border-[#283039]/30">
                    {globalIdx + 1}
                  </div>
                  <div className="flex-1 p-2 flex flex-col justify-center min-w-0">
                    <p className="text-[11px] text-gray-400 font-mono mb-0.5 truncate opacity-60 italic">{sub.start}</p>
                    <input 
                      className="bg-transparent border-none text-xs text-gray-200 focus:outline-none w-full truncate"
                      value={sub.en}
                      onChange={(e) => onSubtitleEdit(sub.id, 'en', e.target.value)}
                    />
                  </div>
                  <div className="flex-1 p-2 flex flex-col justify-center min-w-0 border-l border-[#283039]/30 bg-[#137fec]/5">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Wand2 size={10} className={sub.ko ? "text-[#137fec]" : "text-gray-600"} />
                      <span className="text-[9px] font-black text-gray-500 uppercase tracking-tighter">AI Translation</span>
                    </div>
                    <input 
                      className={`bg-transparent border-none text-xs font-bold focus:outline-none w-full truncate ${
                        sub.ko ? 'text-white' : 'text-gray-600 italic'
                      }`}
                      placeholder="자동 번역 대기 중..."
                      value={sub.ko || ""}
                      onChange={(e) => onSubtitleEdit(sub.id, 'ko', e.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
