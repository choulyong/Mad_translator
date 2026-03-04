"use client";
import React from 'react';
import { Brain, Zap, CheckCircle2 } from 'lucide-react';
import type { StrategyBlueprint } from '@/lib/store/translate-types';

interface StrategyModalProps {
  show: boolean;
  onClose: () => void;
  blueprint: StrategyBlueprint | null;
  onApprove: () => void;
  loading: boolean;
}

export function TranslateStrategyModal({ show, onClose, blueprint, onApprove, loading }: StrategyModalProps) {
  if (!show || !blueprint) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[99999] flex items-center justify-center p-4">
      <div className="bg-[#111418] border border-[#283039] rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[#283039] flex items-center justify-between bg-[#0d1117]">
          <div className="flex items-center gap-3">
            <div className="size-10 bg-[#137fec]/20 rounded-xl flex items-center justify-center">
              <Brain size={20} className="text-[#137fec]" />
            </div>
            <div>
              <h2 className="text-white font-bold text-lg">번역 전략 기획서</h2>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest">
                STRATEGY BLUEPRINT • ID: {blueprint.approval_id}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">✕</button>
        </div>
        
        {/* Modal Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh] space-y-6 custom-scrollbar">
          {/* 1. Content Analysis */}
          <div className="space-y-3">
            <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
              <div className="size-1.5 rounded-full bg-[#137fec]" /> 1. 콘텐츠 분석
            </h3>
            <div className="bg-[#1a232e] rounded-xl p-4 border border-[#283039]">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[9px] text-gray-500 uppercase mb-1">제목</p>
                  <p className="text-white font-bold">{blueprint.content_analysis.estimated_title}</p>
                </div>
                <div>
                  <p className="text-[9px] text-gray-500 uppercase mb-1">장르 / 분위기</p>
                  <p className="text-white">{blueprint.content_analysis.genre} <span className="text-gray-500">·</span> <span className="text-gray-400">{blueprint.content_analysis.mood}</span></p>
                </div>
                <div className="col-span-2">
                  <p className="text-[9px] text-gray-500 uppercase mb-1">요약</p>
                  <p className="text-gray-300 text-sm leading-relaxed">{blueprint.content_analysis.summary}</p>
                </div>
                {blueprint.content_analysis.formality_spectrum && (
                  <div className="col-span-2">
                    <p className="text-[9px] text-gray-500 uppercase mb-1">격식 스펙트럼</p>
                    <p className="text-gray-400 text-xs">{blueprint.content_analysis.formality_spectrum}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 2. Personas */}
          <div className="space-y-3">
            <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
              <div className="size-1.5 rounded-full bg-[#137fec]" /> 2. 캐릭터 페르소나 및 말투
            </h3>
            <div className="grid grid-cols-1 gap-2">
              {blueprint.character_personas.map((persona, idx) => (
                <div key={idx} className="bg-[#1a232e] rounded-xl p-3 border border-[#283039]">
                  <div className="flex items-start gap-3">
                    <div className="size-8 bg-gradient-to-br from-[#137fec] to-[#8b5cf6] rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0">
                      {persona.name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-white font-bold truncate">{persona.name}</p>
                        {persona.gender && <span className="text-[9px] text-gray-500 bg-[#283039] px-1.5 py-0.5 rounded">{persona.gender}</span>}
                        {persona.role && <span className="text-[9px] text-[#137fec]/70 bg-[#137fec]/10 px-1.5 py-0.5 rounded">{persona.role}</span>}
                      </div>
                      <p className="text-[#137fec] text-[10px] mt-1 font-mono">말투: {persona.speech_style}</p>
                      {persona.speech_level_default && (
                        <p className="text-gray-500 text-[10px]">기본 존비어: {persona.speech_level_default}</p>
                      )}
                      {persona.relationships && (
                        <p className="text-gray-500 text-[10px] mt-0.5">관계: {persona.relationships}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 3. Character Relationships */}
          {blueprint.character_relationships && blueprint.character_relationships.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                <div className="size-1.5 rounded-full bg-[#137fec]" /> 3. 캐릭터 관계 맵
              </h3>
              <div className="bg-[#1a232e] rounded-xl border border-[#283039] overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-[#0d1117] text-[9px] text-gray-500 uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">화자</th>
                      <th className="px-3 py-2 text-left">청자</th>
                      <th className="px-3 py-2 text-left">호칭</th>
                      <th className="px-3 py-2 text-left">말투</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#283039]/50">
                    {blueprint.character_relationships.map((rel, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 text-white font-bold">{rel.from_char}</td>
                        <td className="px-3 py-2 text-gray-300">{rel.to_char}</td>
                        <td className="px-3 py-2 text-[#137fec]">{rel.honorific || '-'}</td>
                        <td className="px-3 py-2 text-gray-400">{rel.speech_level || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 4. Fixed Terms */}
          {blueprint.fixed_terms.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                <div className="size-1.5 rounded-full bg-[#137fec]" /> 4. 고정 용어 및 패턴
              </h3>
              <div className="bg-[#1a232e] rounded-xl border border-[#283039] overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-[#0d1117] text-[9px] text-gray-500 uppercase">
                    <tr>
                      <th className="px-4 py-2 text-left">원어</th>
                      <th className="px-4 py-2 text-left">번역</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#283039]/50">
                    {blueprint.fixed_terms.slice(0, 10).map((term, idx) => (
                      <tr key={idx}>
                        <td className="px-4 py-2 text-white font-mono">{term.original}</td>
                        <td className="px-4 py-2 text-[#137fec] font-bold">{term.translation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        
        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-[#283039] bg-[#0d1117] flex items-center justify-between">
          <p className="text-[10px] text-gray-500">전략 승인 시 V2 병렬 번역 엔진이 가동됩니다.</p>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-bold text-gray-400 hover:text-white transition-all">취소</button>
            <button 
              onClick={onApprove}
              disabled={loading}
              className="px-6 py-2 rounded-lg text-xs font-black text-white bg-[#137fec] hover:bg-[#1589ff] shadow-[0_0_20px_rgba(19,127,236,0.3)] transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <Zap size={14} fill="currentColor" />
              전략 승인 및 실행
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
