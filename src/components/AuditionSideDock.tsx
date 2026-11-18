import React, { useState } from 'react';
import { AudioAsset, EditTransaction, Track } from '../contracts/v1_2';
import { formatTimecode, secondsToFlicks } from '../engine/timebase';
import { FileAudio, History, Sliders, Volume2, VolumeX } from 'lucide-react';

interface AuditionChapterMarker {
  id: string;
  label: string;
  startSec: number;
}

interface AuditionSideDockProps {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  sampleRate: number;
  history: EditTransaction[];
  markers: AuditionChapterMarker[];
  onSeekSec: (sec: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onSelectTrackRange?: (trackId: string, startSec: number, endSec: number) => void;
  dspRackNode: React.ReactNode;
}

export const AuditionSideDock: React.FC<AuditionSideDockProps> = ({
  tracks,
  assets,
  sampleRate,
  history,
  markers,
  onSeekSec,
  onToggleTrackMute,
  onToggleTrackSolo,
  onSelectTrackRange,
  dspRackNode,
}) => {
  const [dockTab, setDockTab] = useState<'files' | 'effects' | 'history'>('files');

  return (
    <aside
      data-testid="audition-side-dock"
      aria-label="پنل کناری فایل‌ها، افکت‌ها و تاریخچه ادیشن"
      className="border border-[#2A2F3B] bg-[#1B1E25] rounded-lg overflow-hidden flex flex-col"
    >
      {/* Clean Audition Tab Strip */}
      <div className="grid grid-cols-3 border-b border-[#2A2F3B] bg-[#16181D]">
        <button
          type="button"
          data-testid="audition-dock-tab-files"
          onClick={() => setDockTab('files')}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-2 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
            dockTab === 'files'
              ? 'bg-[#232732] text-[#2EE59D] border-b-2 border-[#2EE59D]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <FileAudio className="w-3.5 h-3.5" aria-hidden="true" />
          <span>فایل‌ها و ترک‌ها</span>
        </button>

        <button
          type="button"
          data-testid="audition-dock-tab-effects"
          onClick={() => setDockTab('effects')}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-2 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
            dockTab === 'effects'
              ? 'bg-[#232732] text-[#2EE59D] border-b-2 border-[#2EE59D]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" aria-hidden="true" />
          <span>رک افکت‌ها</span>
        </button>

        <button
          type="button"
          data-testid="audition-dock-tab-history"
          onClick={() => setDockTab('history')}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-2 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
            dockTab === 'history'
              ? 'bg-[#232732] text-[#2EE59D] border-b-2 border-[#2EE59D]'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <History className="w-3.5 h-3.5" aria-hidden="true" />
          <span>نشانگر و تاریخچه</span>
        </button>
      </div>

      {/* Tab Panel Body */}
      <div className="p-3 space-y-3 max-h-[640px] overflow-y-auto">
        {dockTab === 'files' && (
          <div className="space-y-2.5">
            <div className="text-[11px] text-slate-400 flex items-center justify-between font-mono">
              <span>مدیاهای بارگذاری‌شده</span>
              <span dir="ltr">{sampleRate} Hz</span>
            </div>

            {tracks.map((track) => {
              const firstClip = track.clips[0];
              const asset = firstClip ? assets[firstClip.assetId] : undefined;
              const startSec = firstClip ? firstClip.timelineRange.startFlicks / 705_600_000 : 0;
              const endSec = firstClip ? firstClip.timelineRange.endFlicks / 705_600_000 : 0;

              return (
                <div
                  key={track.id}
                  className="p-2.5 rounded border border-[#2A2F3B] bg-[#14171D] space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100 truncate">
                      {track.name}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onToggleTrackMute(track.id)}
                        aria-label={`قطع صدای ${track.name}`}
                        className={`px-1.5 py-0.5 text-[11px] rounded border cursor-pointer ${
                          track.muted
                            ? 'bg-rose-500/20 border-rose-500/50 text-rose-300'
                            : 'bg-[#1D212A] border-[#2D323E] text-slate-300'
                        }`}
                      >
                        {track.muted ? <VolumeX className="w-3 h-3 inline" /> : <Volume2 className="w-3 h-3 inline" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleTrackSolo(track.id)}
                        aria-label={`تک‌صدایی ${track.name}`}
                        className={`px-1.5 py-0.5 text-[11px] rounded border font-mono cursor-pointer ${
                          track.solo
                            ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                            : 'bg-[#1D212A] border-[#2D323E] text-slate-300'
                        }`}
                      >
                        S
                      </button>
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-400 flex items-center justify-between">
                    <span>{track.speakerLabel}</span>
                    <span dir="ltr" className="font-mono tabular-nums">
                      {asset ? `${asset.name}` : 'PCM Track'}
                    </span>
                  </div>

                  {onSelectTrackRange && endSec > startSec && (
                    <button
                      type="button"
                      onClick={() => onSelectTrackRange(track.id, startSec, endSec)}
                      className="w-full py-1 px-2 text-[11px] rounded border border-[#2D323E] bg-[#1F242E] hover:bg-[#29303E] text-sky-300 cursor-pointer"
                    >
                      انتخاب کل بازه این ترک ({(endSec - startSec).toFixed(1)}s)
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {dockTab === 'effects' && <div>{dspRackNode}</div>}

        {dockTab === 'history' && (
          <div className="space-y-3">
            <div>
              <h3 className="text-xs font-semibold text-slate-200 mb-2">نشانگرها و فصل‌ها (Markers)</h3>
              {markers.length === 0 ? (
                <p className="text-xs text-slate-500">نشانگری ثبت نشده است.</p>
              ) : (
                <div className="space-y-1.5">
                  {markers.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onSeekSec(m.startSec)}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border border-[#2A2F3B] bg-[#14171D] hover:bg-[#222733] text-xs text-slate-200 cursor-pointer"
                    >
                      <span className="truncate">{m.label}</span>
                      <span dir="ltr" className="font-mono tabular-nums text-[11px] text-[#2EE59D]">
                        {formatTimecode(secondsToFlicks(m.startSec))}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-200 mb-2">تاریخچه تغییرات (Undo Stack)</h3>
              {history.length === 0 ? (
                <p className="text-xs text-slate-500">تراکنش تدوینی ثبت نشده است.</p>
              ) : (
                <ul className="space-y-1">
                  {history
                    .slice()
                    .reverse()
                    .map((tx) => (
                      <li
                        key={tx.operationId}
                        className="px-2.5 py-1.5 rounded border border-[#2A2F3B] bg-[#14171D] text-[11px] text-slate-300 flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{tx.description}</span>
                        <span className="font-mono text-slate-500 shrink-0">{tx.type}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
