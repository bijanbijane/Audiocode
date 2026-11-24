import React, { useState } from 'react';
import { AudioAsset, EditTransaction, Track } from '../contracts/v1_2';
import { formatTimecode, secondsToFlicks } from '../engine/timebase';
import {
  BookmarkPlus,
  Edit3,
  FileAudio,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Sliders,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';

export interface AuditionChapterMarker {
  id: string;
  label: string;
  startSec: number;
}

export type AuditionDockTabId = 'files' | 'effects' | 'history';

interface AuditionSideDockProps {
  tracks: Track[];
  assets: Record<string, AudioAsset>;
  sampleRate: number;
  history: EditTransaction[];
  markers: AuditionChapterMarker[];
  locale?: 'fa' | 'en';
  collapsed?: boolean;
  activeDockTab?: AuditionDockTabId;
  onDockTabChange?: (tab: AuditionDockTabId) => void;
  onToggleCollapse?: () => void;
  onImportAudioClick?: () => void;
  onSeekSec: (sec: number) => void;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onSelectTrackRange?: (trackId: string, startSec: number, endSec: number) => void;
  onAddMarker?: () => void;
  onRenameMarker?: (markerId: string, newLabel: string) => void;
  onDeleteMarker?: (markerId: string) => void;
  dspRackNode: React.ReactNode;
}

export const AuditionSideDock: React.FC<AuditionSideDockProps> = ({
  tracks,
  assets,
  sampleRate,
  history,
  markers,
  locale = 'fa',
  collapsed = false,
  activeDockTab: controlledTab,
  onDockTabChange,
  onToggleCollapse,
  onImportAudioClick,
  onSeekSec,
  onToggleTrackMute,
  onToggleTrackSolo,
  onSelectTrackRange,
  onAddMarker,
  onRenameMarker,
  onDeleteMarker,
  dspRackNode,
}) => {
  const isFa = locale === 'fa';
  const [internalDockTab, setInternalDockTab] = useState<AuditionDockTabId>('files');
  const dockTab = controlledTab ?? internalDockTab;
  const setDockTab = (next: AuditionDockTabId) => {
    setInternalDockTab(next);
    onDockTabChange?.(next);
  };
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [editingMarkerLabel, setEditingMarkerLabel] = useState('');

  if (collapsed) {
    return (
      <aside
        data-testid="audition-side-dock"
        aria-label={isFa ? 'نوار کناری جمع‌شده' : 'Collapsed studio rail'}
        className="avp-pane-shell h-full flex flex-col items-center py-2 gap-1.5"
      >
        {onToggleCollapse && (
          <button
            type="button"
            data-testid="btn-toggle-side-dock"
            onClick={onToggleCollapse}
            title={isFa ? 'باز کردن پنل فایل‌ها و افکت‌ها' : 'Expand Files & Effects rail'}
            aria-label={isFa ? 'باز کردن پنل' : 'Expand rail'}
            className="avp-btn-icon avp-btn-icon-sm mb-1"
          >
            <PanelLeftOpen className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          data-testid="audition-dock-tab-files"
          onClick={() => {
            setDockTab('files');
            onToggleCollapse?.();
          }}
          title={isFa ? 'فایل‌ها و ترک‌ها' : 'Files & Tracks'}
          aria-label={isFa ? 'فایل‌ها' : 'Files'}
          className={`avp-btn-icon ${dockTab === 'files' ? 'avp-btn-tonal' : ''}`}
        >
          <FileAudio className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
        </button>

        <button
          type="button"
          data-testid="audition-dock-tab-effects"
          onClick={() => {
            setDockTab('effects');
            onToggleCollapse?.();
          }}
          title={isFa ? 'افکت‌ها و پردازش صوت' : 'Effects & DSP'}
          aria-label={isFa ? 'افکت‌ها' : 'Effects'}
          className={`avp-btn-icon ${dockTab === 'effects' ? 'avp-btn-tonal' : ''}`}
        >
          <Sliders className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
        </button>

        <button
          type="button"
          data-testid="audition-dock-tab-history"
          onClick={() => {
            setDockTab('history');
            onToggleCollapse?.();
          }}
          title={isFa ? 'نشانگرها و تاریخچه' : 'Markers & History'}
          aria-label={isFa ? 'نشانگرها' : 'Markers'}
          className={`avp-btn-icon ${dockTab === 'history' ? 'avp-btn-tonal' : ''}`}
        >
          <History className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-testid="audition-side-dock"
      aria-label={isFa ? 'فایل‌ها، ترک‌ها، افکت‌ها و نشانگرها' : 'Files, Tracks, Effects & Markers'}
      className="avp-pane-shell flex flex-col h-full min-h-0"
    >
      {/* Slim Native Tab Strip (36px — Unified Inset Segmented Capsule aligned with 36px Horizon Line) */}
      <div className="h-[36px] px-2 border-b border-[var(--avp-border)] flex items-center justify-between gap-1.5 shrink-0">
        <div className="flex items-center gap-0.5 flex-1 min-w-0 p-0.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/85">
          <button
            type="button"
            data-testid="audition-dock-tab-files"
            onClick={() => setDockTab('files')}
            className={`flex-1 h-[22px] px-1.5 rounded-[5px] inline-flex items-center justify-center gap-1 text-[10.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
              dockTab === 'files'
                ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
            }`}
          >
            <FileAudio className="w-3 h-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{isFa ? 'فایل‌ها' : 'Files'}</span>
          </button>

          <button
            type="button"
            data-testid="audition-dock-tab-effects"
            onClick={() => setDockTab('effects')}
            className={`flex-1 h-[22px] px-1.5 rounded-[5px] inline-flex items-center justify-center gap-1 text-[10.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
              dockTab === 'effects'
                ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
            }`}
          >
            <Sliders className="w-3 h-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{isFa ? 'افکت‌ها' : 'Effects'}</span>
          </button>

          <button
            type="button"
            data-testid="audition-dock-tab-history"
            onClick={() => setDockTab('history')}
            className={`flex-1 h-[22px] px-1.5 rounded-[5px] inline-flex items-center justify-center gap-1 text-[10.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
              dockTab === 'history'
                ? 'bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs'
                : 'text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]'
            }`}
          >
            <History className="w-3 h-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{isFa ? 'نشانگرها' : 'Markers'}</span>
          </button>
        </div>

        {onToggleCollapse && (
          <button
            type="button"
            data-testid="btn-toggle-side-dock"
            onClick={onToggleCollapse}
            title={isFa ? 'جمع‌کردن پنل برای فضای بیشتر' : 'Collapse side rail'}
            aria-label={isFa ? 'جمع‌کردن پنل' : 'Collapse rail'}
            className="hidden lg:inline-flex items-center justify-center w-[24px] h-[24px] rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface-hover)] shrink-0 cursor-pointer transition-colors"
          >
            <PanelLeftClose className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Scrollable Body */}
      <div className="p-2.5 space-y-2.5 overflow-y-auto flex-1 min-h-0">
        {dockTab === 'files' && (
          <div className="space-y-2">
            <div className="px-1 flex items-center justify-between text-[10.5px] text-[var(--avp-text-muted)]">
              <span className="font-semibold text-[var(--avp-text-secondary)]">
                {isFa ? 'منابع صوتی پروژه' : 'Project Audio Assets'}
              </span>
              <bdi
                dir="ltr"
                className="avp-bidi-num text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--avp-surface-secondary)] border border-[var(--avp-border-subtle)] text-[var(--avp-text-secondary)]"
              >
                {sampleRate / 1000}kHz · PCM
              </bdi>
            </div>

            {/* Studio Asset Cards (Split 2-Pole Metadata Layout: Speaker Right | Duration & File Left) */}
            <div className="space-y-1.5">
              {tracks.map((track, idx) => {
                const isHost = idx === 0;
                const primaryClip =
                  track.clips.find((c) => c.kind === 'speech') ?? track.clips[0];
                const asset = primaryClip ? assets[primaryClip.assetId] : undefined;
                const speechClipsCount = track.clips.filter((c) => c.kind === 'speech').length;
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
                const roleLabel = isHost ? (isFa ? 'میزبان' : 'Host') : isFa ? 'مهمان' : 'Guest';

                return (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => {
                      if (onSelectTrackRange && endSec > startSec) {
                        onSelectTrackRange(track.id, startSec, endSec);
                      }
                    }}
                    title={
                      isFa
                        ? `کلیک برای انتخاب کامل بازه ${track.name}`
                        : `Click to select full range of ${track.name}`
                    }
                    className="w-full p-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)]/70 transition-colors group text-start cursor-pointer space-y-1.5"
                  >
                    {/* Top Row: Speaker + Role (Start) | Duration Pill (End) */}
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isHost ? 'bg-emerald-500' : 'bg-sky-400'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="text-xs font-bold text-[var(--avp-text)] truncate">
                          {track.speakerLabel || track.name}
                        </span>
                        <span className="text-[10px] text-[var(--avp-text-muted)] shrink-0">
                          · {roleLabel}
                        </span>
                      </div>

                      {endSec > startSec && (
                        <bdi
                          dir="ltr"
                          className="avp-bidi-num text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--avp-surface-secondary)] text-[var(--avp-text-secondary)] shrink-0"
                        >
                          {(endSec - startSec).toFixed(1)}s
                        </bdi>
                      )}
                    </div>

                    {/* Bottom Row: Technical Filename (LTR) | Clip Count */}
                    <div className="flex items-center justify-between gap-1.5 text-[10.5px] text-[var(--avp-text-muted)]">
                      <bdi
                        dir="ltr"
                        className="avp-bidi-num text-[10.5px] text-[var(--avp-text-secondary)] truncate group-hover:text-[var(--avp-accent-text)]"
                      >
                        {asset ? asset.name : `Track_${idx + 1}.wav`}
                      </bdi>
                      <span className="text-[10px] shrink-0">
                        {speechClipsCount} {isFa ? 'کلیپ' : 'clip'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {onImportAudioClick && (
              <button
                type="button"
                onClick={onImportAudioClick}
                className="avp-btn avp-btn-sm avp-btn-outline w-full justify-center text-[var(--avp-accent-text)]"
              >
                <Upload className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span>{isFa ? 'افزودن یا جایگزینی فایل صوتی' : 'Import or Replace Audio'}</span>
              </button>
            )}
          </div>
        )}

        {dockTab === 'effects' && <div>{dspRackNode}</div>}

        {dockTab === 'history' && (
          <div className="space-y-4">
            {/* Markers CRUD */}
            <div className="space-y-1.5">
              <div className="px-1 flex items-center justify-between gap-2">
                <h3 className="text-[11.5px] font-semibold text-[var(--avp-text-secondary)]">
                  {isFa ? 'نشانگرها (Markers)' : 'Markers'}
                </h3>
                {onAddMarker && (
                  <button
                    type="button"
                    data-testid="btn-dock-add-marker"
                    onClick={onAddMarker}
                    className="avp-btn avp-btn-sm avp-btn-ghost text-[var(--avp-accent-text)] px-1.5"
                  >
                    <BookmarkPlus className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                    <span>{isFa ? 'افزودن' : 'Add'}</span>
                  </button>
                )}
              </div>

              {markers.length === 0 ? (
                <p className="px-1 text-[11.5px] text-[var(--avp-text-muted)]">
                  {isFa ? 'نشانگری ثبت نشده است.' : 'No markers recorded yet.'}
                </p>
              ) : (
                <div className="divide-y divide-[var(--avp-border-subtle)]">
                  {markers.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-1 py-1.5 px-1.5 hover:bg-[var(--avp-surface-hover)]/60 rounded-md text-xs"
                    >
                      {editingMarkerId === m.id ? (
                        <form
                          className="flex items-center gap-1 flex-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (onRenameMarker && editingMarkerLabel.trim()) {
                              onRenameMarker(m.id, editingMarkerLabel.trim());
                            }
                            setEditingMarkerId(null);
                          }}
                        >
                          <input
                            type="text"
                            autoFocus
                            value={editingMarkerLabel}
                            onChange={(e) => setEditingMarkerLabel(e.target.value)}
                            className="avp-input h-[26px] flex-1 min-w-0 text-xs"
                          />
                          <button type="submit" className="avp-btn avp-btn-sm avp-btn-tonal">
                            {isFa ? 'ثبت' : 'Save'}
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => onSeekSec(m.startSec)}
                            className="flex-1 min-w-0 flex items-center justify-between gap-2 text-start text-[var(--avp-text)] hover:text-[var(--avp-accent-text)] cursor-pointer"
                          >
                            <span className="truncate font-medium">{m.label}</span>
                            <bdi
                              dir="ltr"
                              className="avp-bidi-num text-[10.5px] text-[var(--avp-text-muted)] shrink-0"
                            >
                              {formatTimecode(secondsToFlicks(m.startSec))}
                            </bdi>
                          </button>
                          <div className="flex items-center gap-0.5 shrink-0">
                            {onRenameMarker && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMarkerId(m.id);
                                  setEditingMarkerLabel(m.label);
                                }}
                                aria-label={isFa ? `تغییر نام ${m.label}` : `Rename ${m.label}`}
                                className="avp-btn-icon avp-btn-icon-sm"
                              >
                                <Edit3 className="w-3 h-3" strokeWidth={1.75} />
                              </button>
                            )}
                            {onDeleteMarker && (
                              <button
                                type="button"
                                onClick={() => onDeleteMarker(m.id)}
                                aria-label={isFa ? `حذف ${m.label}` : `Delete ${m.label}`}
                                className="avp-btn-icon avp-btn-icon-sm avp-btn-danger-ghost"
                              >
                                <Trash2 className="w-3 h-3" strokeWidth={1.75} />
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Undo Stack History */}
            <div className="space-y-1.5 pt-2.5 border-t border-[var(--avp-border)]">
              <h3 className="px-1 text-[11.5px] font-semibold text-[var(--avp-text-secondary)]">
                {isFa ? 'تاریخچه تغییرات' : 'Edit History'}
              </h3>
              {history.length === 0 ? (
                <p className="px-1 text-[11.5px] text-[var(--avp-text-muted)]">
                  {isFa ? 'تراکنش تدوینی ثبت نشده است.' : 'No edit transactions yet.'}
                </p>
              ) : (
                <ul className="divide-y divide-[var(--avp-border-subtle)]">
                  {history
                    .slice()
                    .reverse()
                    .map((tx) => (
                      <li
                        key={tx.operationId}
                        className="py-1.5 px-1.5 text-[11px] text-[var(--avp-text-secondary)] flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{tx.description}</span>
                        <span className="font-mono text-[10px] text-[var(--avp-text-faint)] shrink-0">
                          {tx.type}
                        </span>
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
