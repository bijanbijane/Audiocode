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
  locale?: 'fa' | 'en';
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
  locale = 'fa',
  onSeekSec,
  onToggleTrackMute,
  onToggleTrackSolo,
  onSelectTrackRange,
  dspRackNode,
}) => {
  const isFa = locale === 'fa';
  const [dockTab, setDockTab] = useState<'files' | 'effects' | 'history'>('files');

  return (
    <aside
      dir="rtl"
      data-testid="audition-side-dock"
      aria-label={isFa ? 'پنل کناری فایل‌ها، افکت‌ها و تاریخچه ادیشن' : 'Audition Files, Effects & History Dock'}
      className="border border-slate-200 dark:border-[#2A2F3B] bg-white dark:bg-[#1B1E25] rounded-lg overflow-hidden flex flex-col"
    >
      {/* Clean Audition Tab Strip */}
      <div className="grid grid-cols-3 border-b border-slate-200 dark:border-[#2A2F3B] bg-slate-50 dark:bg-[#16181D]">
        <button
          type="button"
          data-testid="audition-dock-tab-files"
          onClick={() => setDockTab('files')}
          title={isFa ? 'فایل‌ها و ترک‌ها' : 'Files & Tracks'}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-2 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
            dockTab === 'files'
              ? 'bg-white dark:bg-[#232732] text-emerald-700 dark:text-[#2EE59D] border-b-2 border-emerald-600 dark:border-[#2EE59D]'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <FileAudio className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{isFa ? 'فایل‌ها' : 'Files'}</span>
        </button>

        <button
          type="button"
          data-testid="audition-dock-tab-effects"
          onClick={() => setDockTab('effects')}
          title={isFa ? 'رک افکت‌ها و DSP' : 'Effects & DSP Rack'}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-2 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
            dockTab === 'effects'
              ? 'bg-white dark:bg-[#232732] text-emerald-700 dark:text-[#2EE59D] border-b-2 border-emerald-600 dark:border-[#2EE59D]'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Sliders className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{isFa ? 'افکت‌ها' : 'Effects'}</span>
        </button>

        <button
          type="button"
          data-testid="audition-dock-tab-history"
          onClick={() => setDockTab('history')}
          title={isFa ? 'نشانگرها و تاریخچه' : 'Markers & History'}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-2 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer ${
            dockTab === 'history'
              ? 'bg-white dark:bg-[#232732] text-emerald-700 dark:text-[#2EE59D] border-b-2 border-emerald-600 dark:border-[#2EE59D]'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>{isFa ? 'نشانگرها' : 'Markers'}</span>
        </button>
      </div>

      {/* Tab Panel Body */}
      <div className="p-3 space-y-3 max-h-[640px] overflow-y-auto">
        {dockTab === 'files' && (
          <div className="space-y-2.5">
            <div className="text-[11px] text-slate-600 dark:text-slate-400 flex items-center justify-between">
              <span className="font-medium">{isFa ? 'مدیاهای بارگذاری‌شده' : 'Loaded Media'}</span>
              <span dir="ltr" className="font-mono tabular-nums">{sampleRate} Hz</span>
            </div>

            {tracks.map((track) => {
              const primaryClip =
                track.clips.find((c) => c.kind === 'speech') ?? track.clips[0];
              const asset = primaryClip ? assets[primaryClip.assetId] : undefined;
              const startFlicks =
                track.clips.length > 0
                  ? Math.min(...track.clips.map((c) => c.timelineRange.startFlicks))
                  : 0;
              const endFlicks =
                track.clips.length > 0
                  ? Math.max(...track.clips.map((c) => c.timelineRange.endFlicks))
                  : 0;
              const startSec = startFlicks / 705_600_000;
              const endSec = endFlicks / 705_600_000;

              return (
                <div
                  key={track.id}
                  className="p-2.5 rounded border border-slate-200 dark:border-[#2A2F3B] bg-slate-50 dark:bg-[#14171D] space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {track.name}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onToggleTrackMute(track.id)}
                        aria-label={isFa ? `قطع صدای ${track.name}` : `Mute ${track.name}`}
                        className={`px-1.5 py-0.5 text-[11px] rounded border cursor-pointer ${
                          track.muted
                            ? 'bg-rose-500/20 border-rose-500/50 text-rose-700 dark:text-rose-300'
                            : 'bg-white dark:bg-[#1D212A] border-slate-300 dark:border-[#2D323E] text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {track.muted ? <VolumeX className="w-3 h-3 inline" /> : <Volume2 className="w-3 h-3 inline" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleTrackSolo(track.id)}
                        aria-label={isFa ? `تک‌صدایی ${track.name}` : `Solo ${track.name}`}
                        className={`px-1.5 py-0.5 text-[11px] rounded border font-mono cursor-pointer ${
                          track.solo
                            ? 'bg-amber-500/20 border-amber-500/50 text-amber-800 dark:text-amber-300'
                            : 'bg-white dark:bg-[#1D212A] border-slate-300 dark:border-[#2D323E] text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        S
                      </button>
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-600 dark:text-slate-400 flex items-center justify-between">
                    <span>{track.speakerLabel}</span>
                    <span dir="ltr" className="font-mono tabular-nums">
                      {asset ? `${asset.name}` : 'PCM Track'}
                    </span>
                  </div>

                  {onSelectTrackRange && endSec > startSec && (
                    <button
                      type="button"
                      onClick={() => onSelectTrackRange(track.id, startSec, endSec)}
                      className="w-full py-1 px-2 text-[11px] font-medium rounded border border-slate-300 dark:border-[#2D323E] bg-white dark:bg-[#1F242E] hover:bg-slate-100 dark:hover:bg-[#29303E] text-sky-700 dark:text-sky-300 cursor-pointer"
                    >
                      {isFa ? (
                        <>
                          انتخاب کل بازه این ترک (<bdi dir="ltr" className="font-mono">{(endSec - startSec).toFixed(1)}s</bdi>)
                        </>
                      ) : (
                        <>
                          Select Full Track (<span className="font-mono">{(endSec - startSec).toFixed(1)}s</span>)
                        </>
                      )}
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
              <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 mb-2">
                {isFa ? 'نشانگرها و فصل‌ها (Markers)' : 'Markers & Chapters'}
              </h3>
              {markers.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {isFa ? 'نشانگری ثبت نشده است.' : 'No markers recorded yet.'}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {markers.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onSeekSec(m.startSec)}
                      className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border border-slate-200 dark:border-[#2A2F3B] bg-slate-50 dark:bg-[#14171D] hover:bg-slate-100 dark:hover:bg-[#222733] text-xs text-slate-800 dark:text-slate-200 cursor-pointer"
                    >
                      <span className="truncate">{m.label}</span>
                      <span dir="ltr" className="font-mono tabular-nums text-[11px] text-emerald-700 dark:text-[#2EE59D]">
                        {formatTimecode(secondsToFlicks(m.startSec))}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200 mb-2">
                {isFa ? 'تاریخچه تغییرات (Undo Stack)' : 'Edit History (Undo Stack)'}
              </h3>
              {history.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {isFa ? 'تراکنش تدوینی ثبت نشده است.' : 'No edit transactions recorded yet.'}
                </p>
              ) : (
                <ul className="space-y-1">
                  {history
                    .slice()
                    .reverse()
                    .map((tx) => (
                      <li
                        key={tx.operationId}
                        className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-[#2A2F3B] bg-slate-50 dark:bg-[#14171D] text-[11px] text-slate-700 dark:text-slate-300 flex items-center justify-between gap-2"
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
