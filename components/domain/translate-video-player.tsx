"use client";
import React from 'react';
import { 
  Play, Pause, Rewind, FastForward, Maximize2, Minimize2, 
  Volume2, VolumeX, PictureInPicture2, Gauge
} from 'lucide-react';
import type { SubtitleBlock } from '@/lib/store/translate-types';

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoContainerRef: React.RefObject<HTMLDivElement | null>;
  videoUrl: string;
  isPlaying: boolean;
  isFullscreen: boolean;
  showControls: boolean;
  volume: number;
  playbackSpeed: number;
  subtitleMode: "original" | "translated" | "both";
  activeSubtitle: any;
  subtitles: SubtitleBlock[];
  onPlayPause: () => void;
  onSkip: (sec: number) => void;
  onVolumeChange: (vol: number) => void;
  onSpeedChange: (speed: number) => void;
  onFullscreenToggle: () => void;
  onPiPToggle: () => void;
  onSubtitleModeChange: (mode: "original" | "translated" | "both") => void;
  onVideoClick: () => void;
  onMouseMove: () => void;
}

export function TranslateVideoPlayer({
  videoRef, videoContainerRef, videoUrl, isPlaying, isFullscreen, showControls,
  volume, playbackSpeed, subtitleMode, activeSubtitle, subtitles,
  onPlayPause, onSkip, onVolumeChange, onSpeedChange, onFullscreenToggle, 
  onPiPToggle, onSubtitleModeChange, onVideoClick, onMouseMove
}: VideoPlayerProps) {
  
  return (
    <div 
      ref={videoContainerRef}
      className={`relative rounded-xl overflow-hidden bg-black border border-[#283039] shadow-2xl group/player transition-all duration-500 ${
        isFullscreen ? 'fixed inset-0 z-[100] rounded-none border-none' : 'aspect-video w-full'
      }`}
      onMouseMove={onMouseMove}
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full h-full object-contain"
          onClick={onVideoClick}
          autoPlay={false}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-4 bg-[#0d1117]">
          <div className="size-16 bg-[#1a232e] rounded-2xl flex items-center justify-center border border-[#283039]">
            <Play size={32} className="text-gray-600" />
          </div>
          <p className="text-gray-500 font-bold text-sm">비디오 파일을 로드하세요</p>
        </div>
      )}

      {/* 🎭 Subtitle Overlay (Cinema Grade) */}
      {videoUrl && (
        <div 
          className="absolute inset-x-0 bottom-[15%] flex flex-col items-center justify-center text-center px-8 pointer-events-none select-none z-30"
          style={{ zIndex: 2147483647 }}
        >
          {activeSubtitle ? (
            <>
              {(subtitleMode === 'both' || subtitleMode === 'original') && (
                <p className="text-gray-200 text-2xl font-medium px-2 mb-2"
                   style={{ textShadow: '2px 2px 4px #000, 0 0 8px #000' }}>
                  {activeSubtitle.en}
                </p>
              )}
              {(subtitleMode === 'both' || subtitleMode === 'translated') && (
                <h2 className="text-white text-5xl font-bold tracking-tight px-2"
                    style={{ textShadow: '3px 3px 6px #000, 0 0 12px #000' }}>
                  {activeSubtitle.ko || (subtitleMode === 'translated' ? activeSubtitle.en : '')}
                </h2>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Subtitle Mode Controls */}
      {subtitles.length > 0 && (
        <div className={`absolute top-4 right-4 flex gap-1 z-40 transition-opacity duration-300 ${
          isFullscreen ? (showControls ? 'opacity-100' : 'opacity-0') : 'opacity-0 group-hover/player:opacity-100'
        }`}>
          {['original', 'both', 'translated'].map((mode) => (
            <button
              key={mode}
              onClick={() => onSubtitleModeChange(mode as any)}
              className={`px-2 py-1 text-[10px] font-bold rounded backdrop-blur-sm ${
                subtitleMode === mode ? 'bg-[#137fec] text-white' : 'bg-black/40 text-gray-300 hover:text-white'
              }`}
            >
              {mode === 'original' ? '원문' : mode === 'both' ? '둘 다' : '번역'}
            </button>
          ))}
        </div>
      )}

      {/* Player Controls - Simplified for space */}
      {videoUrl && (
        <div className={`absolute inset-x-0 bottom-0 p-6 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
        }`}>
          <div className="flex flex-col gap-4">
            {/* Progress Bar */}
            <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden cursor-pointer hover:h-2 transition-all">
              <div 
                className="h-full bg-[#137fec] shadow-[0_0_10px_#137fec]"
                style={{ width: videoRef.current ? `${(videoRef.current.currentTime / (videoRef.current.duration || 1)) * 100}%` : '0%' }}
              />
            </div>
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button onClick={onPlayPause} className="text-white hover:text-[#137fec]">
                  {isPlaying ? <Pause size={24} /> : <Play size={24} fill="currentColor" />}
                </button>
                <div className="flex items-center gap-2">
                  <button onClick={() => onVolumeChange(volume === 0 ? 1 : 0)}>
                    {volume === 0 ? <VolumeX size={20} className="text-red-500" /> : <Volume2 size={20} className="text-white" />}
                  </button>
                </div>
              </div>
              
              <div className="flex items-center gap-4">
                <button onClick={onPiPToggle} className="text-white hover:text-[#137fec]"><PictureInPicture2 size={20} /></button>
                <button onClick={onFullscreenToggle} className="text-white hover:text-[#137fec]">
                  {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
