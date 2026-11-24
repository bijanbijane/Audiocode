const React = __vite__cjsImport0_react; const useState = __vite__cjsImport0_react["useState"];const _jsxDEV = __vite__cjsImport3_react_jsxDevRuntime["jsxDEV"]; const _Fragment = __vite__cjsImport3_react_jsxDevRuntime["Fragment"];import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=dad653c5";
import { formatTimecode, secondsToFlicks } from "/src/engine/timebase.ts";
import { BookmarkPlus, Edit3, FileAudio, History, PanelLeftClose, PanelLeftOpen, Sliders, Trash2, Upload } from "/node_modules/.vite/deps/lucide-react.js?v=dad653c5";
var _jsxFileName = "/app/applet/src/components/AuditionSideDock.tsx";
import __vite__cjsImport3_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=dad653c5";
export const AuditionSideDock = ({ tracks, assets, sampleRate, history, markers, locale = "fa", collapsed = false, activeDockTab: controlledTab, onDockTabChange, onToggleCollapse, onImportAudioClick, onSeekSec, onToggleTrackMute, onToggleTrackSolo, onSelectTrackRange, onAddMarker, onRenameMarker, onDeleteMarker, dspRackNode }) => {
	const isFa = locale === "fa";
	const [internalDockTab, setInternalDockTab] = useState("files");
	const dockTab = controlledTab ?? internalDockTab;
	const setDockTab = (next) => {
		setInternalDockTab(next);
		onDockTabChange?.(next);
	};
	const [editingMarkerId, setEditingMarkerId] = useState(null);
	const [editingMarkerLabel, setEditingMarkerLabel] = useState("");
	if (collapsed) {
		return /* @__PURE__ */ _jsxDEV("aside", {
			"data-testid": "audition-side-dock",
			"aria-label": isFa ? "نوار کناری جمع‌شده" : "Collapsed studio rail",
			className: "avp-pane-shell h-full flex flex-col items-center py-2 gap-1.5",
			children: [
				onToggleCollapse && /* @__PURE__ */ _jsxDEV("button", {
					type: "button",
					"data-testid": "btn-toggle-side-dock",
					onClick: onToggleCollapse,
					title: isFa ? "باز کردن پنل فایل‌ها و افکت‌ها" : "Expand Files & Effects rail",
					"aria-label": isFa ? "باز کردن پنل" : "Expand rail",
					className: "avp-btn-icon avp-btn-icon-sm mb-1",
					children: /* @__PURE__ */ _jsxDEV(PanelLeftOpen, {
						className: "w-4 h-4",
						strokeWidth: 1.75,
						"aria-hidden": "true"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 95,
						columnNumber: 13
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 87,
					columnNumber: 11
				}, this),
				/* @__PURE__ */ _jsxDEV("button", {
					type: "button",
					"data-testid": "audition-dock-tab-files",
					onClick: () => {
						setDockTab("files");
						onToggleCollapse?.();
					},
					title: isFa ? "فایل‌ها و ترک‌ها" : "Files & Tracks",
					"aria-label": isFa ? "فایل‌ها" : "Files",
					className: `avp-btn-icon ${dockTab === "files" ? "avp-btn-tonal" : ""}`,
					children: /* @__PURE__ */ _jsxDEV(FileAudio, {
						className: "w-4 h-4",
						strokeWidth: 1.75,
						"aria-hidden": "true"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 110,
						columnNumber: 11
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 99,
					columnNumber: 9
				}, this),
				/* @__PURE__ */ _jsxDEV("button", {
					type: "button",
					"data-testid": "audition-dock-tab-effects",
					onClick: () => {
						setDockTab("effects");
						onToggleCollapse?.();
					},
					title: isFa ? "افکت‌ها و پردازش صوت" : "Effects & DSP",
					"aria-label": isFa ? "افکت‌ها" : "Effects",
					className: `avp-btn-icon ${dockTab === "effects" ? "avp-btn-tonal" : ""}`,
					children: /* @__PURE__ */ _jsxDEV(Sliders, {
						className: "w-4 h-4",
						strokeWidth: 1.75,
						"aria-hidden": "true"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 124,
						columnNumber: 11
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 113,
					columnNumber: 9
				}, this),
				/* @__PURE__ */ _jsxDEV("button", {
					type: "button",
					"data-testid": "audition-dock-tab-history",
					onClick: () => {
						setDockTab("history");
						onToggleCollapse?.();
					},
					title: isFa ? "نشانگرها و تاریخچه" : "Markers & History",
					"aria-label": isFa ? "نشانگرها" : "Markers",
					className: `avp-btn-icon ${dockTab === "history" ? "avp-btn-tonal" : ""}`,
					children: /* @__PURE__ */ _jsxDEV(History, {
						className: "w-4 h-4",
						strokeWidth: 1.75,
						"aria-hidden": "true"
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 138,
						columnNumber: 11
					}, this)
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 127,
					columnNumber: 9
				}, this)
			]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 81,
			columnNumber: 7
		}, this);
	}
	return /* @__PURE__ */ _jsxDEV("aside", {
		"data-testid": "audition-side-dock",
		"aria-label": isFa ? "فایل‌ها، ترک‌ها، افکت‌ها و نشانگرها" : "Files, Tracks, Effects & Markers",
		className: "avp-pane-shell flex flex-col h-full min-h-0",
		children: [/* @__PURE__ */ _jsxDEV("div", {
			className: "h-[36px] px-2 border-b border-[var(--avp-border)] flex items-center justify-between gap-1.5 shrink-0",
			children: [/* @__PURE__ */ _jsxDEV("div", {
				className: "flex items-center gap-0.5 flex-1 min-w-0 p-0.5 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface-secondary)]/85",
				children: [
					/* @__PURE__ */ _jsxDEV("button", {
						type: "button",
						"data-testid": "audition-dock-tab-files",
						onClick: () => setDockTab("files"),
						className: `flex-1 h-[22px] px-1.5 rounded-[5px] inline-flex items-center justify-center gap-1 text-[10.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${dockTab === "files" ? "bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs" : "text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]"}`,
						children: [/* @__PURE__ */ _jsxDEV(FileAudio, {
							className: "w-3 h-3 shrink-0",
							strokeWidth: 1.75,
							"aria-hidden": "true"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 163,
							columnNumber: 13
						}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "فایل‌ها" : "Files" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 164,
							columnNumber: 13
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 153,
						columnNumber: 11
					}, this),
					/* @__PURE__ */ _jsxDEV("button", {
						type: "button",
						"data-testid": "audition-dock-tab-effects",
						onClick: () => setDockTab("effects"),
						className: `flex-1 h-[22px] px-1.5 rounded-[5px] inline-flex items-center justify-center gap-1 text-[10.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${dockTab === "effects" ? "bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs" : "text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]"}`,
						children: [/* @__PURE__ */ _jsxDEV(Sliders, {
							className: "w-3 h-3 shrink-0",
							strokeWidth: 1.75,
							"aria-hidden": "true"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 177,
							columnNumber: 13
						}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "افکت‌ها" : "Effects" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 178,
							columnNumber: 13
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 167,
						columnNumber: 11
					}, this),
					/* @__PURE__ */ _jsxDEV("button", {
						type: "button",
						"data-testid": "audition-dock-tab-history",
						onClick: () => setDockTab("history"),
						className: `flex-1 h-[22px] px-1.5 rounded-[5px] inline-flex items-center justify-center gap-1 text-[10.5px] font-medium whitespace-nowrap transition-colors cursor-pointer ${dockTab === "history" ? "bg-[var(--avp-surface)] text-[var(--avp-accent-text)] font-semibold shadow-2xs" : "text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)]"}`,
						children: [/* @__PURE__ */ _jsxDEV(History, {
							className: "w-3 h-3 shrink-0",
							strokeWidth: 1.75,
							"aria-hidden": "true"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 191,
							columnNumber: 13
						}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "نشانگرها" : "Markers" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 192,
							columnNumber: 13
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 181,
						columnNumber: 11
					}, this)
				]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 152,
				columnNumber: 9
			}, this), onToggleCollapse && /* @__PURE__ */ _jsxDEV("button", {
				type: "button",
				"data-testid": "btn-toggle-side-dock",
				onClick: onToggleCollapse,
				title: isFa ? "جمع‌کردن پنل برای فضای بیشتر" : "Collapse side rail",
				"aria-label": isFa ? "جمع‌کردن پنل" : "Collapse rail",
				className: "hidden lg:inline-flex items-center justify-center w-[24px] h-[24px] rounded-md border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-text)] hover:bg-[var(--avp-surface-hover)] shrink-0 cursor-pointer transition-colors",
				children: /* @__PURE__ */ _jsxDEV(PanelLeftClose, {
					className: "w-3.5 h-3.5",
					strokeWidth: 1.75,
					"aria-hidden": "true"
				}, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 205,
					columnNumber: 13
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 197,
				columnNumber: 11
			}, this)]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 151,
			columnNumber: 7
		}, this), /* @__PURE__ */ _jsxDEV("div", {
			className: "p-2.5 space-y-2.5 overflow-y-auto flex-1 min-h-0",
			children: [
				dockTab === "files" && /* @__PURE__ */ _jsxDEV("div", {
					className: "space-y-2",
					children: [
						/* @__PURE__ */ _jsxDEV("div", {
							className: "px-1 flex items-center justify-between text-[10.5px] text-[var(--avp-text-muted)]",
							children: [/* @__PURE__ */ _jsxDEV("span", {
								className: "font-semibold text-[var(--avp-text-secondary)]",
								children: isFa ? "منابع صوتی پروژه" : "Project Audio Assets"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 215,
								columnNumber: 15
							}, this), /* @__PURE__ */ _jsxDEV("bdi", {
								dir: "ltr",
								className: "avp-bidi-num text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--avp-surface-secondary)] border border-[var(--avp-border-subtle)] text-[var(--avp-text-secondary)]",
								children: [sampleRate / 1e3, "kHz · PCM"]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 218,
								columnNumber: 15
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 214,
							columnNumber: 13
						}, this),
						/* @__PURE__ */ _jsxDEV("div", {
							className: "space-y-1.5",
							children: tracks.map((track, idx) => {
								const isHost = idx === 0;
								const primaryClip = track.clips.find((c) => c.kind === "speech") ?? track.clips[0];
								const asset = primaryClip ? assets[primaryClip.assetId] : undefined;
								const speechClipsCount = track.clips.filter((c) => c.kind === "speech").length;
								const startFlicks = track.clips.length > 0 ? Math.min(...track.clips.map((c) => c.timelineRange.startFlicks)) : 0;
								const endFlicks = track.clips.length > 0 ? Math.max(...track.clips.map((c) => c.timelineRange.endFlicks)) : 0;
								const startSec = startFlicks / 7056e5;
								const endSec = endFlicks / 7056e5;
								const roleLabel = isHost ? isFa ? "میزبان" : "Host" : isFa ? "مهمان" : "Guest";
								return /* @__PURE__ */ _jsxDEV("button", {
									type: "button",
									onClick: () => {
										if (onSelectTrackRange && endSec > startSec) {
											onSelectTrackRange(track.id, startSec, endSec);
										}
									},
									title: isFa ? `کلیک برای انتخاب کامل بازه ${track.name}` : `Click to select full range of ${track.name}`,
									className: "w-full p-2 rounded-lg border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:bg-[var(--avp-surface-hover)]/70 transition-colors group text-start cursor-pointer space-y-1.5",
									children: [/* @__PURE__ */ _jsxDEV("div", {
										className: "flex items-center justify-between gap-1.5",
										children: [/* @__PURE__ */ _jsxDEV("div", {
											className: "flex items-center gap-1.5 min-w-0",
											children: [
												/* @__PURE__ */ _jsxDEV("span", {
													className: `w-2 h-2 rounded-full shrink-0 ${isHost ? "bg-emerald-500" : "bg-sky-400"}`,
													"aria-hidden": "true"
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 265,
													columnNumber: 25
												}, this),
												/* @__PURE__ */ _jsxDEV("span", {
													className: "text-xs font-bold text-[var(--avp-text)] truncate",
													children: track.speakerLabel || track.name
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 271,
													columnNumber: 25
												}, this),
												/* @__PURE__ */ _jsxDEV("span", {
													className: "text-[10px] text-[var(--avp-text-muted)] shrink-0",
													children: ["· ", roleLabel]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 274,
													columnNumber: 25
												}, this)
											]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 264,
											columnNumber: 23
										}, this), endSec > startSec && /* @__PURE__ */ _jsxDEV("bdi", {
											dir: "ltr",
											className: "avp-bidi-num text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--avp-surface-secondary)] text-[var(--avp-text-secondary)] shrink-0",
											children: [(endSec - startSec).toFixed(1), "s"]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 280,
											columnNumber: 25
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 263,
										columnNumber: 21
									}, this), /* @__PURE__ */ _jsxDEV("div", {
										className: "flex items-center justify-between gap-1.5 text-[10.5px] text-[var(--avp-text-muted)]",
										children: [/* @__PURE__ */ _jsxDEV("bdi", {
											dir: "ltr",
											className: "avp-bidi-num text-[10.5px] text-[var(--avp-text-secondary)] truncate group-hover:text-[var(--avp-accent-text)]",
											children: asset ? asset.name : `Track_${idx + 1}.wav`
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 291,
											columnNumber: 23
										}, this), /* @__PURE__ */ _jsxDEV("span", {
											className: "text-[10px] shrink-0",
											children: [
												speechClipsCount,
												" ",
												isFa ? "کلیپ" : "clip"
											]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 297,
											columnNumber: 23
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 290,
										columnNumber: 21
									}, this)]
								}, track.id, true, {
									fileName: _jsxFileName,
									lineNumber: 247,
									columnNumber: 19
								}, this);
							})
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 227,
							columnNumber: 13
						}, this),
						onImportAudioClick && /* @__PURE__ */ _jsxDEV("button", {
							type: "button",
							onClick: onImportAudioClick,
							className: "avp-btn avp-btn-sm avp-btn-outline w-full justify-center text-[var(--avp-accent-text)]",
							children: [/* @__PURE__ */ _jsxDEV(Upload, {
								className: "w-3.5 h-3.5",
								strokeWidth: 1.75,
								"aria-hidden": "true"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 312,
								columnNumber: 17
							}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "افزودن یا جایگزینی فایل صوتی" : "Import or Replace Audio" }, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 313,
								columnNumber: 17
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 307,
							columnNumber: 15
						}, this)
					]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 213,
					columnNumber: 11
				}, this),
				dockTab === "effects" && /* @__PURE__ */ _jsxDEV("div", { children: dspRackNode }, void 0, false, {
					fileName: _jsxFileName,
					lineNumber: 319,
					columnNumber: 35
				}, this),
				dockTab === "history" && /* @__PURE__ */ _jsxDEV("div", {
					className: "space-y-4",
					children: [/* @__PURE__ */ _jsxDEV("div", {
						className: "space-y-1.5",
						children: [/* @__PURE__ */ _jsxDEV("div", {
							className: "px-1 flex items-center justify-between gap-2",
							children: [/* @__PURE__ */ _jsxDEV("h3", {
								className: "text-[11.5px] font-semibold text-[var(--avp-text-secondary)]",
								children: isFa ? "نشانگرها (Markers)" : "Markers"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 326,
								columnNumber: 17
							}, this), onAddMarker && /* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								"data-testid": "btn-dock-add-marker",
								onClick: onAddMarker,
								className: "avp-btn avp-btn-sm avp-btn-ghost text-[var(--avp-accent-text)] px-1.5",
								children: [/* @__PURE__ */ _jsxDEV(BookmarkPlus, {
									className: "w-3.5 h-3.5",
									strokeWidth: 1.75,
									"aria-hidden": "true"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 336,
									columnNumber: 21
								}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "افزودن" : "Add" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 337,
									columnNumber: 21
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 330,
								columnNumber: 19
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 325,
							columnNumber: 15
						}, this), markers.length === 0 ? /* @__PURE__ */ _jsxDEV("p", {
							className: "px-1 text-[11.5px] text-[var(--avp-text-muted)]",
							children: isFa ? "نشانگری ثبت نشده است." : "No markers recorded yet."
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 343,
							columnNumber: 17
						}, this) : /* @__PURE__ */ _jsxDEV("div", {
							className: "divide-y divide-[var(--avp-border-subtle)]",
							children: markers.map((m) => /* @__PURE__ */ _jsxDEV("div", {
								className: "flex items-center justify-between gap-1 py-1.5 px-1.5 hover:bg-[var(--avp-surface-hover)]/60 rounded-md text-xs",
								children: editingMarkerId === m.id ? /* @__PURE__ */ _jsxDEV("form", {
									className: "flex items-center gap-1 flex-1",
									onSubmit: (e) => {
										e.preventDefault();
										if (onRenameMarker && editingMarkerLabel.trim()) {
											onRenameMarker(m.id, editingMarkerLabel.trim());
										}
										setEditingMarkerId(null);
									},
									children: [/* @__PURE__ */ _jsxDEV("input", {
										type: "text",
										autoFocus: true,
										value: editingMarkerLabel,
										onChange: (e) => setEditingMarkerLabel(e.target.value),
										className: "avp-input h-[26px] flex-1 min-w-0 text-xs"
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 364,
										columnNumber: 27
									}, this), /* @__PURE__ */ _jsxDEV("button", {
										type: "submit",
										className: "avp-btn avp-btn-sm avp-btn-tonal",
										children: isFa ? "ثبت" : "Save"
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 371,
										columnNumber: 27
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 354,
									columnNumber: 25
								}, this) : /* @__PURE__ */ _jsxDEV(_Fragment, { children: [/* @__PURE__ */ _jsxDEV("button", {
									type: "button",
									onClick: () => onSeekSec(m.startSec),
									className: "flex-1 min-w-0 flex items-center justify-between gap-2 text-start text-[var(--avp-text)] hover:text-[var(--avp-accent-text)] cursor-pointer",
									children: [/* @__PURE__ */ _jsxDEV("span", {
										className: "truncate font-medium",
										children: m.label
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 382,
										columnNumber: 29
									}, this), /* @__PURE__ */ _jsxDEV("bdi", {
										dir: "ltr",
										className: "avp-bidi-num text-[10.5px] text-[var(--avp-text-muted)] shrink-0",
										children: formatTimecode(secondsToFlicks(m.startSec))
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 383,
										columnNumber: 29
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 377,
									columnNumber: 27
								}, this), /* @__PURE__ */ _jsxDEV("div", {
									className: "flex items-center gap-0.5 shrink-0",
									children: [onRenameMarker && /* @__PURE__ */ _jsxDEV("button", {
										type: "button",
										onClick: () => {
											setEditingMarkerId(m.id);
											setEditingMarkerLabel(m.label);
										},
										"aria-label": isFa ? `تغییر نام ${m.label}` : `Rename ${m.label}`,
										className: "avp-btn-icon avp-btn-icon-sm",
										children: /* @__PURE__ */ _jsxDEV(Edit3, {
											className: "w-3 h-3",
											strokeWidth: 1.75
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 401,
											columnNumber: 33
										}, this)
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 392,
										columnNumber: 31
									}, this), onDeleteMarker && /* @__PURE__ */ _jsxDEV("button", {
										type: "button",
										onClick: () => onDeleteMarker(m.id),
										"aria-label": isFa ? `حذف ${m.label}` : `Delete ${m.label}`,
										className: "avp-btn-icon avp-btn-icon-sm avp-btn-danger-ghost",
										children: /* @__PURE__ */ _jsxDEV(Trash2, {
											className: "w-3 h-3",
											strokeWidth: 1.75
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 411,
											columnNumber: 33
										}, this)
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 405,
										columnNumber: 31
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 390,
									columnNumber: 27
								}, this)] }, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 376,
									columnNumber: 25
								}, this)
							}, m.id, false, {
								fileName: _jsxFileName,
								lineNumber: 349,
								columnNumber: 21
							}, this))
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 347,
							columnNumber: 17
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 324,
						columnNumber: 13
					}, this), /* @__PURE__ */ _jsxDEV("div", {
						className: "space-y-1.5 pt-2.5 border-t border-[var(--avp-border)]",
						children: [/* @__PURE__ */ _jsxDEV("h3", {
							className: "px-1 text-[11.5px] font-semibold text-[var(--avp-text-secondary)]",
							children: isFa ? "تاریخچه تغییرات" : "Edit History"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 425,
							columnNumber: 15
						}, this), history.length === 0 ? /* @__PURE__ */ _jsxDEV("p", {
							className: "px-1 text-[11.5px] text-[var(--avp-text-muted)]",
							children: isFa ? "تراکنش تدوینی ثبت نشده است." : "No edit transactions yet."
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 429,
							columnNumber: 17
						}, this) : /* @__PURE__ */ _jsxDEV("ul", {
							className: "divide-y divide-[var(--avp-border-subtle)]",
							children: history.slice().reverse().map((tx) => /* @__PURE__ */ _jsxDEV("li", {
								className: "py-1.5 px-1.5 text-[11px] text-[var(--avp-text-secondary)] flex items-center justify-between gap-2",
								children: [/* @__PURE__ */ _jsxDEV("span", {
									className: "truncate",
									children: tx.description
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 442,
									columnNumber: 25
								}, this), /* @__PURE__ */ _jsxDEV("span", {
									className: "font-mono text-[10px] text-[var(--avp-text-faint)] shrink-0",
									children: tx.type
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 443,
									columnNumber: 25
								}, this)]
							}, tx.operationId, true, {
								fileName: _jsxFileName,
								lineNumber: 438,
								columnNumber: 23
							}, this))
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 433,
							columnNumber: 17
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 424,
						columnNumber: 13
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 322,
					columnNumber: 11
				}, this)
			]
		}, void 0, true, {
			fileName: _jsxFileName,
			lineNumber: 211,
			columnNumber: 7
		}, this)]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 145,
		columnNumber: 5
	}, this);
};

//# sourceMappingURL=data:application/json;base64,eyJtYXBwaW5ncyI6IkFBQUEsT0FBTyxTQUFTLGdCQUFnQjtBQUVoQyxTQUFTLGdCQUFnQix1QkFBdUI7QUFDaEQsU0FDRSxjQUNBLE9BQ0EsV0FDQSxTQUNBLGdCQUNBLGVBQ0EsU0FDQSxRQUNBLGNBR0s7OztBQWdDUCxPQUFPLE1BQU0sb0JBQXFELEVBQ2hFLFFBQ0EsUUFDQSxZQUNBLFNBQ0EsU0FDQSxTQUFTLE1BQ1QsWUFBWSxPQUNaLGVBQWUsZUFDZixpQkFDQSxrQkFDQSxvQkFDQSxXQUNBLG1CQUNBLG1CQUNBLG9CQUNBLGFBQ0EsZ0JBQ0EsZ0JBQ0Esa0JBQ0k7Q0FDSixNQUFNLE9BQU8sV0FBVztDQUN4QixNQUFNLENBQUMsaUJBQWlCLHNCQUFzQixTQUE0QixPQUFPO0NBQ2pGLE1BQU0sVUFBVSxpQkFBaUI7Q0FDakMsTUFBTSxjQUFjLFNBQTRCO0VBQzlDLG1CQUFtQixJQUFJO0VBQ3ZCLGtCQUFrQixJQUFJO0NBQ3hCO0NBQ0EsTUFBTSxDQUFDLGlCQUFpQixzQkFBc0IsU0FBd0IsSUFBSTtDQUMxRSxNQUFNLENBQUMsb0JBQW9CLHlCQUF5QixTQUFTLEVBQUU7Q0FFL0QsSUFBSSxXQUFXO0VBQ2IsT0FDRSx3QkFBQyxTQUFEO0dBQ0UsZUFBWTtHQUNaLGNBQVksT0FBTyx1QkFBdUI7R0FDMUMsV0FBVTthQUhaO0lBS0csb0JBQ0Msd0JBQUMsVUFBRDtLQUNFLE1BQUs7S0FDTCxlQUFZO0tBQ1osU0FBUztLQUNULE9BQU8sT0FBTyxtQ0FBbUM7S0FDakQsY0FBWSxPQUFPLGlCQUFpQjtLQUNwQyxXQUFVO2VBRVYsd0JBQUMsZUFBRDtNQUFlLFdBQVU7TUFBVSxhQUFhO01BQU0sZUFBWTtLQUFROzs7OztJQUNwRTs7Ozs7SUFHVix3QkFBQyxVQUFEO0tBQ0UsTUFBSztLQUNMLGVBQVk7S0FDWixlQUFlO01BQ2IsV0FBVyxPQUFPO01BQ2xCLG1CQUFtQjtLQUNyQjtLQUNBLE9BQU8sT0FBTyxxQkFBcUI7S0FDbkMsY0FBWSxPQUFPLFlBQVk7S0FDL0IsV0FBVyxnQkFBZ0IsWUFBWSxVQUFVLGtCQUFrQjtlQUVuRSx3QkFBQyxXQUFEO01BQVcsV0FBVTtNQUFVLGFBQWE7TUFBTSxlQUFZO0tBQVE7Ozs7O0lBQ2hFOzs7OztJQUVSLHdCQUFDLFVBQUQ7S0FDRSxNQUFLO0tBQ0wsZUFBWTtLQUNaLGVBQWU7TUFDYixXQUFXLFNBQVM7TUFDcEIsbUJBQW1CO0tBQ3JCO0tBQ0EsT0FBTyxPQUFPLHlCQUF5QjtLQUN2QyxjQUFZLE9BQU8sWUFBWTtLQUMvQixXQUFXLGdCQUFnQixZQUFZLFlBQVksa0JBQWtCO2VBRXJFLHdCQUFDLFNBQUQ7TUFBUyxXQUFVO01BQVUsYUFBYTtNQUFNLGVBQVk7S0FBUTs7Ozs7SUFDOUQ7Ozs7O0lBRVIsd0JBQUMsVUFBRDtLQUNFLE1BQUs7S0FDTCxlQUFZO0tBQ1osZUFBZTtNQUNiLFdBQVcsU0FBUztNQUNwQixtQkFBbUI7S0FDckI7S0FDQSxPQUFPLE9BQU8sdUJBQXVCO0tBQ3JDLGNBQVksT0FBTyxhQUFhO0tBQ2hDLFdBQVcsZ0JBQWdCLFlBQVksWUFBWSxrQkFBa0I7ZUFFckUsd0JBQUMsU0FBRDtNQUFTLFdBQVU7TUFBVSxhQUFhO01BQU0sZUFBWTtLQUFROzs7OztJQUM5RDs7Ozs7R0FDSDs7Ozs7O0NBRVg7Q0FFQSxPQUNFLHdCQUFDLFNBQUQ7RUFDRSxlQUFZO0VBQ1osY0FBWSxPQUFPLHdDQUF3QztFQUMzRCxXQUFVO1lBSFosQ0FNRSx3QkFBQyxPQUFEO0dBQUssV0FBVTthQUFmLENBQ0Usd0JBQUMsT0FBRDtJQUFLLFdBQVU7Y0FBZjtLQUNFLHdCQUFDLFVBQUQ7TUFDRSxNQUFLO01BQ0wsZUFBWTtNQUNaLGVBQWUsV0FBVyxPQUFPO01BQ2pDLFdBQVcsbUtBQ1QsWUFBWSxVQUNSLG1GQUNBO2dCQVBSLENBVUUsd0JBQUMsV0FBRDtPQUFXLFdBQVU7T0FBbUIsYUFBYTtPQUFNLGVBQVk7TUFBUTs7OztnQkFDL0Usd0JBQUMsUUFBRCxZQUFPLE9BQU8sWUFBWSxRQUFjOzs7O2NBQ2xDOzs7Ozs7S0FFUix3QkFBQyxVQUFEO01BQ0UsTUFBSztNQUNMLGVBQVk7TUFDWixlQUFlLFdBQVcsU0FBUztNQUNuQyxXQUFXLG1LQUNULFlBQVksWUFDUixtRkFDQTtnQkFQUixDQVVFLHdCQUFDLFNBQUQ7T0FBUyxXQUFVO09BQW1CLGFBQWE7T0FBTSxlQUFZO01BQVE7Ozs7Z0JBQzdFLHdCQUFDLFFBQUQsWUFBTyxPQUFPLFlBQVksVUFBZ0I7Ozs7Y0FDcEM7Ozs7OztLQUVSLHdCQUFDLFVBQUQ7TUFDRSxNQUFLO01BQ0wsZUFBWTtNQUNaLGVBQWUsV0FBVyxTQUFTO01BQ25DLFdBQVcsbUtBQ1QsWUFBWSxZQUNSLG1GQUNBO2dCQVBSLENBVUUsd0JBQUMsU0FBRDtPQUFTLFdBQVU7T0FBbUIsYUFBYTtPQUFNLGVBQVk7TUFBUTs7OztnQkFDN0Usd0JBQUMsUUFBRCxZQUFPLE9BQU8sYUFBYSxVQUFnQjs7OztjQUNyQzs7Ozs7O0lBQ0w7Ozs7O2FBRUosb0JBQ0Msd0JBQUMsVUFBRDtJQUNFLE1BQUs7SUFDTCxlQUFZO0lBQ1osU0FBUztJQUNULE9BQU8sT0FBTyxpQ0FBaUM7SUFDL0MsY0FBWSxPQUFPLGlCQUFpQjtJQUNwQyxXQUFVO2NBRVYsd0JBQUMsZ0JBQUQ7S0FBZ0IsV0FBVTtLQUFjLGFBQWE7S0FBTSxlQUFZO0lBQVE7Ozs7O0dBQ3pFOzs7O1dBRVA7Ozs7O1lBR0wsd0JBQUMsT0FBRDtHQUFLLFdBQVU7YUFBZjtJQUNHLFlBQVksV0FDWCx3QkFBQyxPQUFEO0tBQUssV0FBVTtlQUFmO01BQ0Usd0JBQUMsT0FBRDtPQUFLLFdBQVU7aUJBQWYsQ0FDRSx3QkFBQyxRQUFEO1FBQU0sV0FBVTtrQkFDYixPQUFPLHFCQUFxQjtPQUN6Qjs7OztpQkFDTix3QkFBQyxPQUFEO1FBQ0UsS0FBSTtRQUNKLFdBQVU7a0JBRlosQ0FJRyxhQUFhLEtBQUssV0FDaEI7Ozs7O2VBQ0Y7Ozs7OztNQUdMLHdCQUFDLE9BQUQ7T0FBSyxXQUFVO2lCQUNaLE9BQU8sS0FBSyxPQUFPLFFBQVE7UUFDMUIsTUFBTSxTQUFTLFFBQVE7UUFDdkIsTUFBTSxjQUNKLE1BQU0sTUFBTSxNQUFNLE1BQU0sRUFBRSxTQUFTLFFBQVEsS0FBSyxNQUFNLE1BQU07UUFDOUQsTUFBTSxRQUFRLGNBQWMsT0FBTyxZQUFZLFdBQVc7UUFDMUQsTUFBTSxtQkFBbUIsTUFBTSxNQUFNLFFBQVEsTUFBTSxFQUFFLFNBQVMsUUFBUSxDQUFDLENBQUM7UUFDeEUsTUFBTSxjQUNKLE1BQU0sTUFBTSxTQUFTLElBQ2pCLEtBQUssSUFBSSxHQUFHLE1BQU0sTUFBTSxLQUFLLE1BQU0sRUFBRSxjQUFjLFdBQVcsQ0FBQyxJQUMvRDtRQUNOLE1BQU0sWUFDSixNQUFNLE1BQU0sU0FBUyxJQUNqQixLQUFLLElBQUksR0FBRyxNQUFNLE1BQU0sS0FBSyxNQUFNLEVBQUUsY0FBYyxTQUFTLENBQUMsSUFDN0Q7UUFDTixNQUFNLFdBQVcsY0FBYztRQUMvQixNQUFNLFNBQVMsWUFBWTtRQUMzQixNQUFNLFlBQVksU0FBVSxPQUFPLFdBQVcsU0FBVSxPQUFPLFVBQVU7UUFFekUsT0FDRSx3QkFBQyxVQUFEO1NBRUUsTUFBSztTQUNMLGVBQWU7VUFDYixJQUFJLHNCQUFzQixTQUFTLFVBQVU7V0FDM0MsbUJBQW1CLE1BQU0sSUFBSSxVQUFVLE1BQU07VUFDL0M7U0FDRjtTQUNBLE9BQ0UsT0FDSSw4QkFBOEIsTUFBTSxTQUNwQyxpQ0FBaUMsTUFBTTtTQUU3QyxXQUFVO21CQWJaLENBZ0JFLHdCQUFDLE9BQUQ7VUFBSyxXQUFVO29CQUFmLENBQ0Usd0JBQUMsT0FBRDtXQUFLLFdBQVU7cUJBQWY7WUFDRSx3QkFBQyxRQUFEO2FBQ0UsV0FBVyxpQ0FDVCxTQUFTLG1CQUFtQjthQUU5QixlQUFZO1lBQ2I7Ozs7O1lBQ0Qsd0JBQUMsUUFBRDthQUFNLFdBQVU7dUJBQ2IsTUFBTSxnQkFBZ0IsTUFBTTtZQUN6Qjs7Ozs7WUFDTix3QkFBQyxRQUFEO2FBQU0sV0FBVTt1QkFBaEIsQ0FBb0UsTUFDL0QsU0FDQzs7Ozs7O1dBQ0g7Ozs7O29CQUVKLFNBQVMsWUFDUix3QkFBQyxPQUFEO1dBQ0UsS0FBSTtXQUNKLFdBQVU7cUJBRlosRUFJSSxTQUFTLFNBQVEsQ0FBRSxRQUFRLENBQUMsR0FBRSxHQUM3Qjs7Ozs7a0JBRUo7Ozs7O21CQUdMLHdCQUFDLE9BQUQ7VUFBSyxXQUFVO29CQUFmLENBQ0Usd0JBQUMsT0FBRDtXQUNFLEtBQUk7V0FDSixXQUFVO3FCQUVULFFBQVEsTUFBTSxPQUFPLFNBQVMsTUFBTSxFQUFFO1VBQ3BDOzs7O29CQUNMLHdCQUFDLFFBQUQ7V0FBTSxXQUFVO3FCQUFoQjtZQUNHO1lBQWlCO1lBQUUsT0FBTyxTQUFTO1dBQ2hDOzs7OztrQkFDSDs7Ozs7aUJBQ0M7V0FyREQsTUFBTTs7OztlQXFETDtPQUVaLENBQUM7TUFDRTs7Ozs7TUFFSixzQkFDQyx3QkFBQyxVQUFEO09BQ0UsTUFBSztPQUNMLFNBQVM7T0FDVCxXQUFVO2lCQUhaLENBS0Usd0JBQUMsUUFBRDtRQUFRLFdBQVU7UUFBYyxhQUFhO1FBQU0sZUFBWTtPQUFROzs7O2lCQUN2RSx3QkFBQyxRQUFELFlBQU8sT0FBTyxpQ0FBaUMsMEJBQWdDOzs7O2VBQ3pFOzs7Ozs7S0FFUDs7Ozs7O0lBR04sWUFBWSxhQUFhLHdCQUFDLE9BQUQsWUFBTSxZQUFpQjs7Ozs7SUFFaEQsWUFBWSxhQUNYLHdCQUFDLE9BQUQ7S0FBSyxXQUFVO2VBQWYsQ0FFRSx3QkFBQyxPQUFEO01BQUssV0FBVTtnQkFBZixDQUNFLHdCQUFDLE9BQUQ7T0FBSyxXQUFVO2lCQUFmLENBQ0Usd0JBQUMsTUFBRDtRQUFJLFdBQVU7a0JBQ1gsT0FBTyx1QkFBdUI7T0FDN0I7Ozs7aUJBQ0gsZUFDQyx3QkFBQyxVQUFEO1FBQ0UsTUFBSztRQUNMLGVBQVk7UUFDWixTQUFTO1FBQ1QsV0FBVTtrQkFKWixDQU1FLHdCQUFDLGNBQUQ7U0FBYyxXQUFVO1NBQWMsYUFBYTtTQUFNLGVBQVk7UUFBUTs7OztrQkFDN0Usd0JBQUMsUUFBRCxZQUFPLE9BQU8sV0FBVyxNQUFZOzs7O2dCQUMvQjs7Ozs7ZUFFUDs7Ozs7Z0JBRUosUUFBUSxXQUFXLElBQ2xCLHdCQUFDLEtBQUQ7T0FBRyxXQUFVO2lCQUNWLE9BQU8sMEJBQTBCO01BQ2pDOzs7O2lCQUVILHdCQUFDLE9BQUQ7T0FBSyxXQUFVO2lCQUNaLFFBQVEsS0FBSyxNQUNaLHdCQUFDLE9BQUQ7UUFFRSxXQUFVO2tCQUVULG9CQUFvQixFQUFFLEtBQ3JCLHdCQUFDLFFBQUQ7U0FDRSxXQUFVO1NBQ1YsV0FBVyxNQUFNO1VBQ2YsRUFBRSxlQUFlO1VBQ2pCLElBQUksa0JBQWtCLG1CQUFtQixLQUFLLEdBQUc7V0FDL0MsZUFBZSxFQUFFLElBQUksbUJBQW1CLEtBQUssQ0FBQztVQUNoRDtVQUNBLG1CQUFtQixJQUFJO1NBQ3pCO21CQVJGLENBVUUsd0JBQUMsU0FBRDtVQUNFLE1BQUs7VUFDTDtVQUNBLE9BQU87VUFDUCxXQUFXLE1BQU0sc0JBQXNCLEVBQUUsT0FBTyxLQUFLO1VBQ3JELFdBQVU7U0FDWDs7OzttQkFDRCx3QkFBQyxVQUFEO1VBQVEsTUFBSztVQUFTLFdBQVU7b0JBQzdCLE9BQU8sUUFBUTtTQUNWOzs7O2lCQUNKOzs7OzttQkFFTixnREFDRSx3QkFBQyxVQUFEO1NBQ0UsTUFBSztTQUNMLGVBQWUsVUFBVSxFQUFFLFFBQVE7U0FDbkMsV0FBVTttQkFIWixDQUtFLHdCQUFDLFFBQUQ7VUFBTSxXQUFVO29CQUF3QixFQUFFO1NBQVk7Ozs7bUJBQ3RELHdCQUFDLE9BQUQ7VUFDRSxLQUFJO1VBQ0osV0FBVTtvQkFFVCxlQUFlLGdCQUFnQixFQUFFLFFBQVEsQ0FBQztTQUN4Qzs7OztpQkFDQzs7Ozs7a0JBQ1Isd0JBQUMsT0FBRDtTQUFLLFdBQVU7bUJBQWYsQ0FDRyxrQkFDQyx3QkFBQyxVQUFEO1VBQ0UsTUFBSztVQUNMLGVBQWU7V0FDYixtQkFBbUIsRUFBRSxFQUFFO1dBQ3ZCLHNCQUFzQixFQUFFLEtBQUs7VUFDL0I7VUFDQSxjQUFZLE9BQU8sYUFBYSxFQUFFLFVBQVUsVUFBVSxFQUFFO1VBQ3hELFdBQVU7b0JBRVYsd0JBQUMsT0FBRDtXQUFPLFdBQVU7V0FBVSxhQUFhO1VBQU87Ozs7O1NBQ3pDOzs7O21CQUVULGtCQUNDLHdCQUFDLFVBQUQ7VUFDRSxNQUFLO1VBQ0wsZUFBZSxlQUFlLEVBQUUsRUFBRTtVQUNsQyxjQUFZLE9BQU8sT0FBTyxFQUFFLFVBQVUsVUFBVSxFQUFFO1VBQ2xELFdBQVU7b0JBRVYsd0JBQUMsUUFBRDtXQUFRLFdBQVU7V0FBVSxhQUFhO1VBQU87Ozs7O1NBQzFDOzs7O2lCQUVQOzs7OztnQkFDTDs7Ozs7T0FFRCxHQW5FRSxFQUFFOzs7O2NBbUVKLENBQ047TUFDRTs7OztjQUVKOzs7OztlQUdMLHdCQUFDLE9BQUQ7TUFBSyxXQUFVO2dCQUFmLENBQ0Usd0JBQUMsTUFBRDtPQUFJLFdBQVU7aUJBQ1gsT0FBTyxvQkFBb0I7TUFDMUI7Ozs7Z0JBQ0gsUUFBUSxXQUFXLElBQ2xCLHdCQUFDLEtBQUQ7T0FBRyxXQUFVO2lCQUNWLE9BQU8sZ0NBQWdDO01BQ3ZDOzs7O2lCQUVILHdCQUFDLE1BQUQ7T0FBSSxXQUFVO2lCQUNYLFFBQ0UsTUFBTSxDQUFDLENBQ1AsUUFBUSxDQUFDLENBQ1QsS0FBSyxPQUNKLHdCQUFDLE1BQUQ7UUFFRSxXQUFVO2tCQUZaLENBSUUsd0JBQUMsUUFBRDtTQUFNLFdBQVU7bUJBQVksR0FBRztRQUFrQjs7OztrQkFDakQsd0JBQUMsUUFBRDtTQUFNLFdBQVU7bUJBQ2IsR0FBRztRQUNBOzs7O2dCQUNKO1VBUEcsR0FBRzs7OztjQU9OLENBQ0w7TUFDRDs7OztjQUVIOzs7OzthQUNGOzs7Ozs7R0FFSjs7Ozs7VUFDQTs7Ozs7O0FBRVgiLCJuYW1lcyI6W10sInNvdXJjZXMiOlsiQXVkaXRpb25TaWRlRG9jay50c3giXSwidmVyc2lvbiI6Mywic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnO1xuaW1wb3J0IHsgQXVkaW9Bc3NldCwgRWRpdFRyYW5zYWN0aW9uLCBUcmFjayB9IGZyb20gJy4uL2NvbnRyYWN0cy92MV8yJztcbmltcG9ydCB7IGZvcm1hdFRpbWVjb2RlLCBzZWNvbmRzVG9GbGlja3MgfSBmcm9tICcuLi9lbmdpbmUvdGltZWJhc2UnO1xuaW1wb3J0IHtcbiAgQm9va21hcmtQbHVzLFxuICBFZGl0MyxcbiAgRmlsZUF1ZGlvLFxuICBIaXN0b3J5LFxuICBQYW5lbExlZnRDbG9zZSxcbiAgUGFuZWxMZWZ0T3BlbixcbiAgU2xpZGVycyxcbiAgVHJhc2gyLFxuICBVcGxvYWQsXG4gIFZvbHVtZTIsXG4gIFZvbHVtZVgsXG59IGZyb20gJ2x1Y2lkZS1yZWFjdCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXVkaXRpb25DaGFwdGVyTWFya2VyIHtcbiAgaWQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgc3RhcnRTZWM6IG51bWJlcjtcbn1cblxuZXhwb3J0IHR5cGUgQXVkaXRpb25Eb2NrVGFiSWQgPSAnZmlsZXMnIHwgJ2VmZmVjdHMnIHwgJ2hpc3RvcnknO1xuXG5pbnRlcmZhY2UgQXVkaXRpb25TaWRlRG9ja1Byb3BzIHtcbiAgdHJhY2tzOiBUcmFja1tdO1xuICBhc3NldHM6IFJlY29yZDxzdHJpbmcsIEF1ZGlvQXNzZXQ+O1xuICBzYW1wbGVSYXRlOiBudW1iZXI7XG4gIGhpc3Rvcnk6IEVkaXRUcmFuc2FjdGlvbltdO1xuICBtYXJrZXJzOiBBdWRpdGlvbkNoYXB0ZXJNYXJrZXJbXTtcbiAgbG9jYWxlPzogJ2ZhJyB8ICdlbic7XG4gIGNvbGxhcHNlZD86IGJvb2xlYW47XG4gIGFjdGl2ZURvY2tUYWI/OiBBdWRpdGlvbkRvY2tUYWJJZDtcbiAgb25Eb2NrVGFiQ2hhbmdlPzogKHRhYjogQXVkaXRpb25Eb2NrVGFiSWQpID0+IHZvaWQ7XG4gIG9uVG9nZ2xlQ29sbGFwc2U/OiAoKSA9PiB2b2lkO1xuICBvbkltcG9ydEF1ZGlvQ2xpY2s/OiAoKSA9PiB2b2lkO1xuICBvblNlZWtTZWM6IChzZWM6IG51bWJlcikgPT4gdm9pZDtcbiAgb25Ub2dnbGVUcmFja011dGU6ICh0cmFja0lkOiBzdHJpbmcpID0+IHZvaWQ7XG4gIG9uVG9nZ2xlVHJhY2tTb2xvOiAodHJhY2tJZDogc3RyaW5nKSA9PiB2b2lkO1xuICBvblNlbGVjdFRyYWNrUmFuZ2U/OiAodHJhY2tJZDogc3RyaW5nLCBzdGFydFNlYzogbnVtYmVyLCBlbmRTZWM6IG51bWJlcikgPT4gdm9pZDtcbiAgb25BZGRNYXJrZXI/OiAoKSA9PiB2b2lkO1xuICBvblJlbmFtZU1hcmtlcj86IChtYXJrZXJJZDogc3RyaW5nLCBuZXdMYWJlbDogc3RyaW5nKSA9PiB2b2lkO1xuICBvbkRlbGV0ZU1hcmtlcj86IChtYXJrZXJJZDogc3RyaW5nKSA9PiB2b2lkO1xuICBkc3BSYWNrTm9kZTogUmVhY3QuUmVhY3ROb2RlO1xufVxuXG5leHBvcnQgY29uc3QgQXVkaXRpb25TaWRlRG9jazogUmVhY3QuRkM8QXVkaXRpb25TaWRlRG9ja1Byb3BzPiA9ICh7XG4gIHRyYWNrcyxcbiAgYXNzZXRzLFxuICBzYW1wbGVSYXRlLFxuICBoaXN0b3J5LFxuICBtYXJrZXJzLFxuICBsb2NhbGUgPSAnZmEnLFxuICBjb2xsYXBzZWQgPSBmYWxzZSxcbiAgYWN0aXZlRG9ja1RhYjogY29udHJvbGxlZFRhYixcbiAgb25Eb2NrVGFiQ2hhbmdlLFxuICBvblRvZ2dsZUNvbGxhcHNlLFxuICBvbkltcG9ydEF1ZGlvQ2xpY2ssXG4gIG9uU2Vla1NlYyxcbiAgb25Ub2dnbGVUcmFja011dGUsXG4gIG9uVG9nZ2xlVHJhY2tTb2xvLFxuICBvblNlbGVjdFRyYWNrUmFuZ2UsXG4gIG9uQWRkTWFya2VyLFxuICBvblJlbmFtZU1hcmtlcixcbiAgb25EZWxldGVNYXJrZXIsXG4gIGRzcFJhY2tOb2RlLFxufSkgPT4ge1xuICBjb25zdCBpc0ZhID0gbG9jYWxlID09PSAnZmEnO1xuICBjb25zdCBbaW50ZXJuYWxEb2NrVGFiLCBzZXRJbnRlcm5hbERvY2tUYWJdID0gdXNlU3RhdGU8QXVkaXRpb25Eb2NrVGFiSWQ+KCdmaWxlcycpO1xuICBjb25zdCBkb2NrVGFiID0gY29udHJvbGxlZFRhYiA/PyBpbnRlcm5hbERvY2tUYWI7XG4gIGNvbnN0IHNldERvY2tUYWIgPSAobmV4dDogQXVkaXRpb25Eb2NrVGFiSWQpID0+IHtcbiAgICBzZXRJbnRlcm5hbERvY2tUYWIobmV4dCk7XG4gICAgb25Eb2NrVGFiQ2hhbmdlPy4obmV4dCk7XG4gIH07XG4gIGNvbnN0IFtlZGl0aW5nTWFya2VySWQsIHNldEVkaXRpbmdNYXJrZXJJZF0gPSB1c2VTdGF0ZTxzdHJpbmcgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW2VkaXRpbmdNYXJrZXJMYWJlbCwgc2V0RWRpdGluZ01hcmtlckxhYmVsXSA9IHVzZVN0YXRlKCcnKTtcblxuICBpZiAoY29sbGFwc2VkKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxhc2lkZVxuICAgICAgICBkYXRhLXRlc3RpZD1cImF1ZGl0aW9uLXNpZGUtZG9ja1wiXG4gICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2YbZiNin2LEg2qnZhtin2LHbjCDYrNmF2LnigIzYtNiv2YcnIDogJ0NvbGxhcHNlZCBzdHVkaW8gcmFpbCd9XG4gICAgICAgIGNsYXNzTmFtZT1cImF2cC1wYW5lLXNoZWxsIGgtZnVsbCBmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciBweS0yIGdhcC0xLjVcIlxuICAgICAgPlxuICAgICAgICB7b25Ub2dnbGVDb2xsYXBzZSAmJiAoXG4gICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICBkYXRhLXRlc3RpZD1cImJ0bi10b2dnbGUtc2lkZS1kb2NrXCJcbiAgICAgICAgICAgIG9uQ2xpY2s9e29uVG9nZ2xlQ29sbGFwc2V9XG4gICAgICAgICAgICB0aXRsZT17aXNGYSA/ICfYqNin2LIg2qnYsdiv2YYg2b7ZhtmEINmB2KfbjNmE4oCM2YfYpyDZiCDYp9mB2qnYquKAjNmH2KcnIDogJ0V4cGFuZCBGaWxlcyAmIEVmZmVjdHMgcmFpbCd9XG4gICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gJ9io2KfYsiDaqdix2K/ZhiDZvtmG2YQnIDogJ0V4cGFuZCByYWlsJ31cbiAgICAgICAgICAgIGNsYXNzTmFtZT1cImF2cC1idG4taWNvbiBhdnAtYnRuLWljb24tc20gbWItMVwiXG4gICAgICAgICAgPlxuICAgICAgICAgICAgPFBhbmVsTGVmdE9wZW4gY2xhc3NOYW1lPVwidy00IGgtNFwiIHN0cm9rZVdpZHRoPXsxLjc1fSBhcmlhLWhpZGRlbj1cInRydWVcIiAvPlxuICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICApfVxuXG4gICAgICAgIDxidXR0b25cbiAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICBkYXRhLXRlc3RpZD1cImF1ZGl0aW9uLWRvY2stdGFiLWZpbGVzXCJcbiAgICAgICAgICBvbkNsaWNrPXsoKSA9PiB7XG4gICAgICAgICAgICBzZXREb2NrVGFiKCdmaWxlcycpO1xuICAgICAgICAgICAgb25Ub2dnbGVDb2xsYXBzZT8uKCk7XG4gICAgICAgICAgfX1cbiAgICAgICAgICB0aXRsZT17aXNGYSA/ICfZgdin24zZhOKAjNmH2Kcg2Ygg2KrYsdqp4oCM2YfYpycgOiAnRmlsZXMgJiBUcmFja3MnfVxuICAgICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2YHYp9uM2YTigIzZh9inJyA6ICdGaWxlcyd9XG4gICAgICAgICAgY2xhc3NOYW1lPXtgYXZwLWJ0bi1pY29uICR7ZG9ja1RhYiA9PT0gJ2ZpbGVzJyA/ICdhdnAtYnRuLXRvbmFsJyA6ICcnfWB9XG4gICAgICAgID5cbiAgICAgICAgICA8RmlsZUF1ZGlvIGNsYXNzTmFtZT1cInctNCBoLTRcIiBzdHJva2VXaWR0aD17MS43NX0gYXJpYS1oaWRkZW49XCJ0cnVlXCIgLz5cbiAgICAgICAgPC9idXR0b24+XG5cbiAgICAgICAgPGJ1dHRvblxuICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgIGRhdGEtdGVzdGlkPVwiYXVkaXRpb24tZG9jay10YWItZWZmZWN0c1wiXG4gICAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgICAgc2V0RG9ja1RhYignZWZmZWN0cycpO1xuICAgICAgICAgICAgb25Ub2dnbGVDb2xsYXBzZT8uKCk7XG4gICAgICAgICAgfX1cbiAgICAgICAgICB0aXRsZT17aXNGYSA/ICfYp9mB2qnYquKAjNmH2Kcg2Ygg2b7Ysdiv2KfYsti0INi12YjYqicgOiAnRWZmZWN0cyAmIERTUCd9XG4gICAgICAgICAgYXJpYS1sYWJlbD17aXNGYSA/ICfYp9mB2qnYquKAjNmH2KcnIDogJ0VmZmVjdHMnfVxuICAgICAgICAgIGNsYXNzTmFtZT17YGF2cC1idG4taWNvbiAke2RvY2tUYWIgPT09ICdlZmZlY3RzJyA/ICdhdnAtYnRuLXRvbmFsJyA6ICcnfWB9XG4gICAgICAgID5cbiAgICAgICAgICA8U2xpZGVycyBjbGFzc05hbWU9XCJ3LTQgaC00XCIgc3Ryb2tlV2lkdGg9ezEuNzV9IGFyaWEtaGlkZGVuPVwidHJ1ZVwiIC8+XG4gICAgICAgIDwvYnV0dG9uPlxuXG4gICAgICAgIDxidXR0b25cbiAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICBkYXRhLXRlc3RpZD1cImF1ZGl0aW9uLWRvY2stdGFiLWhpc3RvcnlcIlxuICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICAgIHNldERvY2tUYWIoJ2hpc3RvcnknKTtcbiAgICAgICAgICAgIG9uVG9nZ2xlQ29sbGFwc2U/LigpO1xuICAgICAgICAgIH19XG4gICAgICAgICAgdGl0bGU9e2lzRmEgPyAn2YbYtNin2Ybar9ix2YfYpyDZiCDYqtin2LHbjNiu2obZhycgOiAnTWFya2VycyAmIEhpc3RvcnknfVxuICAgICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2YbYtNin2Ybar9ix2YfYpycgOiAnTWFya2Vycyd9XG4gICAgICAgICAgY2xhc3NOYW1lPXtgYXZwLWJ0bi1pY29uICR7ZG9ja1RhYiA9PT0gJ2hpc3RvcnknID8gJ2F2cC1idG4tdG9uYWwnIDogJyd9YH1cbiAgICAgICAgPlxuICAgICAgICAgIDxIaXN0b3J5IGNsYXNzTmFtZT1cInctNCBoLTRcIiBzdHJva2VXaWR0aD17MS43NX0gYXJpYS1oaWRkZW49XCJ0cnVlXCIgLz5cbiAgICAgICAgPC9idXR0b24+XG4gICAgICA8L2FzaWRlPlxuICAgICk7XG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxhc2lkZVxuICAgICAgZGF0YS10ZXN0aWQ9XCJhdWRpdGlvbi1zaWRlLWRvY2tcIlxuICAgICAgYXJpYS1sYWJlbD17aXNGYSA/ICfZgdin24zZhOKAjNmH2KfYjCDYqtix2qnigIzZh9in2Iwg2KfZgdqp2KrigIzZh9inINmIINmG2LTYp9mG2q/YsdmH2KcnIDogJ0ZpbGVzLCBUcmFja3MsIEVmZmVjdHMgJiBNYXJrZXJzJ31cbiAgICAgIGNsYXNzTmFtZT1cImF2cC1wYW5lLXNoZWxsIGZsZXggZmxleC1jb2wgaC1mdWxsIG1pbi1oLTBcIlxuICAgID5cbiAgICAgIHsvKiBTbGltIE5hdGl2ZSBUYWIgU3RyaXAgKDM2cHgg4oCUIFVuaWZpZWQgSW5zZXQgU2VnbWVudGVkIENhcHN1bGUgYWxpZ25lZCB3aXRoIDM2cHggSG9yaXpvbiBMaW5lKSAqL31cbiAgICAgIDxkaXYgY2xhc3NOYW1lPVwiaC1bMzZweF0gcHgtMiBib3JkZXItYiBib3JkZXItW3ZhcigtLWF2cC1ib3JkZXIpXSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTEuNSBzaHJpbmstMFwiPlxuICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0wLjUgZmxleC0xIG1pbi13LTAgcC0wLjUgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyKV0gYmctW3ZhcigtLWF2cC1zdXJmYWNlLXNlY29uZGFyeSldLzg1XCI+XG4gICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICBkYXRhLXRlc3RpZD1cImF1ZGl0aW9uLWRvY2stdGFiLWZpbGVzXCJcbiAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHNldERvY2tUYWIoJ2ZpbGVzJyl9XG4gICAgICAgICAgICBjbGFzc05hbWU9e2BmbGV4LTEgaC1bMjJweF0gcHgtMS41IHJvdW5kZWQtWzVweF0gaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGdhcC0xIHRleHQtWzEwLjVweF0gZm9udC1tZWRpdW0gd2hpdGVzcGFjZS1ub3dyYXAgdHJhbnNpdGlvbi1jb2xvcnMgY3Vyc29yLXBvaW50ZXIgJHtcbiAgICAgICAgICAgICAgZG9ja1RhYiA9PT0gJ2ZpbGVzJ1xuICAgICAgICAgICAgICAgID8gJ2JnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHRleHQtW3ZhcigtLWF2cC1hY2NlbnQtdGV4dCldIGZvbnQtc2VtaWJvbGQgc2hhZG93LTJ4cydcbiAgICAgICAgICAgICAgICA6ICd0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBob3Zlcjp0ZXh0LVt2YXIoLS1hdnAtdGV4dCldJ1xuICAgICAgICAgICAgfWB9XG4gICAgICAgICAgPlxuICAgICAgICAgICAgPEZpbGVBdWRpbyBjbGFzc05hbWU9XCJ3LTMgaC0zIHNocmluay0wXCIgc3Ryb2tlV2lkdGg9ezEuNzV9IGFyaWEtaGlkZGVuPVwidHJ1ZVwiIC8+XG4gICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfZgdin24zZhOKAjNmH2KcnIDogJ0ZpbGVzJ308L3NwYW4+XG4gICAgICAgICAgPC9idXR0b24+XG5cbiAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgIGRhdGEtdGVzdGlkPVwiYXVkaXRpb24tZG9jay10YWItZWZmZWN0c1wiXG4gICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiBzZXREb2NrVGFiKCdlZmZlY3RzJyl9XG4gICAgICAgICAgICBjbGFzc05hbWU9e2BmbGV4LTEgaC1bMjJweF0gcHgtMS41IHJvdW5kZWQtWzVweF0gaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGdhcC0xIHRleHQtWzEwLjVweF0gZm9udC1tZWRpdW0gd2hpdGVzcGFjZS1ub3dyYXAgdHJhbnNpdGlvbi1jb2xvcnMgY3Vyc29yLXBvaW50ZXIgJHtcbiAgICAgICAgICAgICAgZG9ja1RhYiA9PT0gJ2VmZmVjdHMnXG4gICAgICAgICAgICAgICAgPyAnYmctW3ZhcigtLWF2cC1zdXJmYWNlKV0gdGV4dC1bdmFyKC0tYXZwLWFjY2VudC10ZXh0KV0gZm9udC1zZW1pYm9sZCBzaGFkb3ctMnhzJ1xuICAgICAgICAgICAgICAgIDogJ3RleHQtW3ZhcigtLWF2cC10ZXh0LXNlY29uZGFyeSldIGhvdmVyOnRleHQtW3ZhcigtLWF2cC10ZXh0KV0nXG4gICAgICAgICAgICB9YH1cbiAgICAgICAgICA+XG4gICAgICAgICAgICA8U2xpZGVycyBjbGFzc05hbWU9XCJ3LTMgaC0zIHNocmluay0wXCIgc3Ryb2tlV2lkdGg9ezEuNzV9IGFyaWEtaGlkZGVuPVwidHJ1ZVwiIC8+XG4gICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfYp9mB2qnYquKAjNmH2KcnIDogJ0VmZmVjdHMnfTwvc3Bhbj5cbiAgICAgICAgICA8L2J1dHRvbj5cblxuICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJhdWRpdGlvbi1kb2NrLXRhYi1oaXN0b3J5XCJcbiAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHNldERvY2tUYWIoJ2hpc3RvcnknKX1cbiAgICAgICAgICAgIGNsYXNzTmFtZT17YGZsZXgtMSBoLVsyMnB4XSBweC0xLjUgcm91bmRlZC1bNXB4XSBpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgZ2FwLTEgdGV4dC1bMTAuNXB4XSBmb250LW1lZGl1bSB3aGl0ZXNwYWNlLW5vd3JhcCB0cmFuc2l0aW9uLWNvbG9ycyBjdXJzb3ItcG9pbnRlciAke1xuICAgICAgICAgICAgICBkb2NrVGFiID09PSAnaGlzdG9yeSdcbiAgICAgICAgICAgICAgICA/ICdiZy1bdmFyKC0tYXZwLXN1cmZhY2UpXSB0ZXh0LVt2YXIoLS1hdnAtYWNjZW50LXRleHQpXSBmb250LXNlbWlib2xkIHNoYWRvdy0yeHMnXG4gICAgICAgICAgICAgICAgOiAndGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gaG92ZXI6dGV4dC1bdmFyKC0tYXZwLXRleHQpXSdcbiAgICAgICAgICAgIH1gfVxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxIaXN0b3J5IGNsYXNzTmFtZT1cInctMyBoLTMgc2hyaW5rLTBcIiBzdHJva2VXaWR0aD17MS43NX0gYXJpYS1oaWRkZW49XCJ0cnVlXCIgLz5cbiAgICAgICAgICAgIDxzcGFuPntpc0ZhID8gJ9mG2LTYp9mG2q/YsdmH2KcnIDogJ01hcmtlcnMnfTwvc3Bhbj5cbiAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG5cbiAgICAgICAge29uVG9nZ2xlQ29sbGFwc2UgJiYgKFxuICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJidG4tdG9nZ2xlLXNpZGUtZG9ja1wiXG4gICAgICAgICAgICBvbkNsaWNrPXtvblRvZ2dsZUNvbGxhcHNlfVxuICAgICAgICAgICAgdGl0bGU9e2lzRmEgPyAn2KzZhdi54oCM2qnYsdiv2YYg2b7ZhtmEINio2LHYp9uMINmB2LbYp9uMINio24zYtNiq2LEnIDogJ0NvbGxhcHNlIHNpZGUgcmFpbCd9XG4gICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gJ9is2YXYueKAjNqp2LHYr9mGINm+2YbZhCcgOiAnQ29sbGFwc2UgcmFpbCd9XG4gICAgICAgICAgICBjbGFzc05hbWU9XCJoaWRkZW4gbGc6aW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHctWzI0cHhdIGgtWzI0cHhdIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHRleHQtW3ZhcigtLWF2cC10ZXh0LXNlY29uZGFyeSldIGhvdmVyOnRleHQtW3ZhcigtLWF2cC10ZXh0KV0gaG92ZXI6YmctW3ZhcigtLWF2cC1zdXJmYWNlLWhvdmVyKV0gc2hyaW5rLTAgY3Vyc29yLXBvaW50ZXIgdHJhbnNpdGlvbi1jb2xvcnNcIlxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxQYW5lbExlZnRDbG9zZSBjbGFzc05hbWU9XCJ3LTMuNSBoLTMuNVwiIHN0cm9rZVdpZHRoPXsxLjc1fSBhcmlhLWhpZGRlbj1cInRydWVcIiAvPlxuICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICApfVxuICAgICAgPC9kaXY+XG5cbiAgICAgIHsvKiBTY3JvbGxhYmxlIEJvZHkgKi99XG4gICAgICA8ZGl2IGNsYXNzTmFtZT1cInAtMi41IHNwYWNlLXktMi41IG92ZXJmbG93LXktYXV0byBmbGV4LTEgbWluLWgtMFwiPlxuICAgICAgICB7ZG9ja1RhYiA9PT0gJ2ZpbGVzJyAmJiAoXG4gICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJzcGFjZS15LTJcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwicHgtMSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gdGV4dC1bMTAuNXB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1tdXRlZCldXCI+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cImZvbnQtc2VtaWJvbGQgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV1cIj5cbiAgICAgICAgICAgICAgICB7aXNGYSA/ICfZhdmG2KfYqNi5INi12YjYqtuMINm+2LHZiNqY2YcnIDogJ1Byb2plY3QgQXVkaW8gQXNzZXRzJ31cbiAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgICA8YmRpXG4gICAgICAgICAgICAgICAgZGlyPVwibHRyXCJcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJhdnAtYmlkaS1udW0gdGV4dC1bOS41cHhdIHB4LTEuNSBweS0wLjUgcm91bmRlZCBiZy1bdmFyKC0tYXZwLXN1cmZhY2Utc2Vjb25kYXJ5KV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlci1zdWJ0bGUpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXVwiXG4gICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICB7c2FtcGxlUmF0ZSAvIDEwMDB9a0h6IMK3IFBDTVxuICAgICAgICAgICAgICA8L2JkaT5cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICB7LyogU3R1ZGlvIEFzc2V0IENhcmRzIChTcGxpdCAyLVBvbGUgTWV0YWRhdGEgTGF5b3V0OiBTcGVha2VyIFJpZ2h0IHwgRHVyYXRpb24gJiBGaWxlIExlZnQpICovfVxuICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJzcGFjZS15LTEuNVwiPlxuICAgICAgICAgICAgICB7dHJhY2tzLm1hcCgodHJhY2ssIGlkeCkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IGlzSG9zdCA9IGlkeCA9PT0gMDtcbiAgICAgICAgICAgICAgICBjb25zdCBwcmltYXJ5Q2xpcCA9XG4gICAgICAgICAgICAgICAgICB0cmFjay5jbGlwcy5maW5kKChjKSA9PiBjLmtpbmQgPT09ICdzcGVlY2gnKSA/PyB0cmFjay5jbGlwc1swXTtcbiAgICAgICAgICAgICAgICBjb25zdCBhc3NldCA9IHByaW1hcnlDbGlwID8gYXNzZXRzW3ByaW1hcnlDbGlwLmFzc2V0SWRdIDogdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGNvbnN0IHNwZWVjaENsaXBzQ291bnQgPSB0cmFjay5jbGlwcy5maWx0ZXIoKGMpID0+IGMua2luZCA9PT0gJ3NwZWVjaCcpLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBjb25zdCBzdGFydEZsaWNrcyA9XG4gICAgICAgICAgICAgICAgICB0cmFjay5jbGlwcy5sZW5ndGggPiAwXG4gICAgICAgICAgICAgICAgICAgID8gTWF0aC5taW4oLi4udHJhY2suY2xpcHMubWFwKChjKSA9PiBjLnRpbWVsaW5lUmFuZ2Uuc3RhcnRGbGlja3MpKVxuICAgICAgICAgICAgICAgICAgICA6IDA7XG4gICAgICAgICAgICAgICAgY29uc3QgZW5kRmxpY2tzID1cbiAgICAgICAgICAgICAgICAgIHRyYWNrLmNsaXBzLmxlbmd0aCA+IDBcbiAgICAgICAgICAgICAgICAgICAgPyBNYXRoLm1heCguLi50cmFjay5jbGlwcy5tYXAoKGMpID0+IGMudGltZWxpbmVSYW5nZS5lbmRGbGlja3MpKVxuICAgICAgICAgICAgICAgICAgICA6IDA7XG4gICAgICAgICAgICAgICAgY29uc3Qgc3RhcnRTZWMgPSBzdGFydEZsaWNrcyAvIDcwNV82MDBfMDAwO1xuICAgICAgICAgICAgICAgIGNvbnN0IGVuZFNlYyA9IGVuZEZsaWNrcyAvIDcwNV82MDBfMDAwO1xuICAgICAgICAgICAgICAgIGNvbnN0IHJvbGVMYWJlbCA9IGlzSG9zdCA/IChpc0ZhID8gJ9mF24zYstio2KfZhicgOiAnSG9zdCcpIDogaXNGYSA/ICfZhdmH2YXYp9mGJyA6ICdHdWVzdCc7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgICAgICBrZXk9e3RyYWNrLmlkfVxuICAgICAgICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmIChvblNlbGVjdFRyYWNrUmFuZ2UgJiYgZW5kU2VjID4gc3RhcnRTZWMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uU2VsZWN0VHJhY2tSYW5nZSh0cmFjay5pZCwgc3RhcnRTZWMsIGVuZFNlYyk7XG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICB0aXRsZT17XG4gICAgICAgICAgICAgICAgICAgICAgaXNGYVxuICAgICAgICAgICAgICAgICAgICAgICAgPyBg2qnZhNuM2qkg2KjYsdin24wg2KfZhtiq2K7Yp9ioINqp2KfZhdmEINio2KfYstmHICR7dHJhY2submFtZX1gXG4gICAgICAgICAgICAgICAgICAgICAgICA6IGBDbGljayB0byBzZWxlY3QgZnVsbCByYW5nZSBvZiAke3RyYWNrLm5hbWV9YFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInctZnVsbCBwLTIgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyKV0gYmctW3ZhcigtLWF2cC1zdXJmYWNlKV0gaG92ZXI6YmctW3ZhcigtLWF2cC1zdXJmYWNlLWhvdmVyKV0vNzAgdHJhbnNpdGlvbi1jb2xvcnMgZ3JvdXAgdGV4dC1zdGFydCBjdXJzb3ItcG9pbnRlciBzcGFjZS15LTEuNVwiXG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIHsvKiBUb3AgUm93OiBTcGVha2VyICsgUm9sZSAoU3RhcnQpIHwgRHVyYXRpb24gUGlsbCAoRW5kKSAqL31cbiAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTEuNVwiPlxuICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSBtaW4tdy0wXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICA8c3BhblxuICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9e2B3LTIgaC0yIHJvdW5kZWQtZnVsbCBzaHJpbmstMCAke1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzSG9zdCA/ICdiZy1lbWVyYWxkLTUwMCcgOiAnYmctc2t5LTQwMCdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGFyaWEtaGlkZGVuPVwidHJ1ZVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3NOYW1lPVwidGV4dC14cyBmb250LWJvbGQgdGV4dC1bdmFyKC0tYXZwLXRleHQpXSB0cnVuY2F0ZVwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICB7dHJhY2suc3BlYWtlckxhYmVsIHx8IHRyYWNrLm5hbWV9XG4gICAgICAgICAgICAgICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9XCJ0ZXh0LVsxMHB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1tdXRlZCldIHNocmluay0wXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIMK3IHtyb2xlTGFiZWx9XG4gICAgICAgICAgICAgICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgICAgICAgICAgICB7ZW5kU2VjID4gc3RhcnRTZWMgJiYgKFxuICAgICAgICAgICAgICAgICAgICAgICAgPGJkaVxuICAgICAgICAgICAgICAgICAgICAgICAgICBkaXI9XCJsdHJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJhdnAtYmlkaS1udW0gdGV4dC1bMTBweF0gZm9udC1tZWRpdW0gcHgtMS41IHB5LTAuNSByb3VuZGVkIGJnLVt2YXIoLS1hdnAtc3VyZmFjZS1zZWNvbmRhcnkpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBzaHJpbmstMFwiXG4gICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHsoZW5kU2VjIC0gc3RhcnRTZWMpLnRvRml4ZWQoMSl9c1xuICAgICAgICAgICAgICAgICAgICAgICAgPC9iZGk+XG4gICAgICAgICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgICAgICAgICAgey8qIEJvdHRvbSBSb3c6IFRlY2huaWNhbCBGaWxlbmFtZSAoTFRSKSB8IENsaXAgQ291bnQgKi99XG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0xLjUgdGV4dC1bMTAuNXB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1tdXRlZCldXCI+XG4gICAgICAgICAgICAgICAgICAgICAgPGJkaVxuICAgICAgICAgICAgICAgICAgICAgICAgZGlyPVwibHRyXCJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImF2cC1iaWRpLW51bSB0ZXh0LVsxMC41cHhdIHRleHQtW3ZhcigtLWF2cC10ZXh0LXNlY29uZGFyeSldIHRydW5jYXRlIGdyb3VwLWhvdmVyOnRleHQtW3ZhcigtLWF2cC1hY2NlbnQtdGV4dCldXCJcbiAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICB7YXNzZXQgPyBhc3NldC5uYW1lIDogYFRyYWNrXyR7aWR4ICsgMX0ud2F2YH1cbiAgICAgICAgICAgICAgICAgICAgICA8L2JkaT5cbiAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9XCJ0ZXh0LVsxMHB4XSBzaHJpbmstMFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAge3NwZWVjaENsaXBzQ291bnR9IHtpc0ZhID8gJ9qp2YTbjNm+JyA6ICdjbGlwJ31cbiAgICAgICAgICAgICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfSl9XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAge29uSW1wb3J0QXVkaW9DbGljayAmJiAoXG4gICAgICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgICBvbkNsaWNrPXtvbkltcG9ydEF1ZGlvQ2xpY2t9XG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiYXZwLWJ0biBhdnAtYnRuLXNtIGF2cC1idG4tb3V0bGluZSB3LWZ1bGwganVzdGlmeS1jZW50ZXIgdGV4dC1bdmFyKC0tYXZwLWFjY2VudC10ZXh0KV1cIlxuICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgPFVwbG9hZCBjbGFzc05hbWU9XCJ3LTMuNSBoLTMuNVwiIHN0cm9rZVdpZHRoPXsxLjc1fSBhcmlhLWhpZGRlbj1cInRydWVcIiAvPlxuICAgICAgICAgICAgICAgIDxzcGFuPntpc0ZhID8gJ9in2YHYstmI2K/ZhiDbjNinINis2KfbjNqv2LLbjNmG24wg2YHYp9uM2YQg2LXZiNiq24wnIDogJ0ltcG9ydCBvciBSZXBsYWNlIEF1ZGlvJ308L3NwYW4+XG4gICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgKX1cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cblxuICAgICAgICB7ZG9ja1RhYiA9PT0gJ2VmZmVjdHMnICYmIDxkaXY+e2RzcFJhY2tOb2RlfTwvZGl2Pn1cblxuICAgICAgICB7ZG9ja1RhYiA9PT0gJ2hpc3RvcnknICYmIChcbiAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInNwYWNlLXktNFwiPlxuICAgICAgICAgICAgey8qIE1hcmtlcnMgQ1JVRCAqL31cbiAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwic3BhY2UteS0xLjVcIj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJweC0xIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMlwiPlxuICAgICAgICAgICAgICAgIDxoMyBjbGFzc05hbWU9XCJ0ZXh0LVsxMS41cHhdIGZvbnQtc2VtaWJvbGQgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV1cIj5cbiAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9mG2LTYp9mG2q/YsdmH2KcgKE1hcmtlcnMpJyA6ICdNYXJrZXJzJ31cbiAgICAgICAgICAgICAgICA8L2gzPlxuICAgICAgICAgICAgICAgIHtvbkFkZE1hcmtlciAmJiAoXG4gICAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgICAgICBkYXRhLXRlc3RpZD1cImJ0bi1kb2NrLWFkZC1tYXJrZXJcIlxuICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXtvbkFkZE1hcmtlcn1cbiAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiYXZwLWJ0biBhdnAtYnRuLXNtIGF2cC1idG4tZ2hvc3QgdGV4dC1bdmFyKC0tYXZwLWFjY2VudC10ZXh0KV0gcHgtMS41XCJcbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgPEJvb2ttYXJrUGx1cyBjbGFzc05hbWU9XCJ3LTMuNSBoLTMuNVwiIHN0cm9rZVdpZHRoPXsxLjc1fSBhcmlhLWhpZGRlbj1cInRydWVcIiAvPlxuICAgICAgICAgICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfYp9mB2LLZiNiv2YYnIDogJ0FkZCd9PC9zcGFuPlxuICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgICAge21hcmtlcnMubGVuZ3RoID09PSAwID8gKFxuICAgICAgICAgICAgICAgIDxwIGNsYXNzTmFtZT1cInB4LTEgdGV4dC1bMTEuNXB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1tdXRlZCldXCI+XG4gICAgICAgICAgICAgICAgICB7aXNGYSA/ICfZhti02KfZhtqv2LHbjCDYq9io2Kog2YbYtNiv2Ycg2KfYs9iqLicgOiAnTm8gbWFya2VycyByZWNvcmRlZCB5ZXQuJ31cbiAgICAgICAgICAgICAgICA8L3A+XG4gICAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJkaXZpZGUteSBkaXZpZGUtW3ZhcigtLWF2cC1ib3JkZXItc3VidGxlKV1cIj5cbiAgICAgICAgICAgICAgICAgIHttYXJrZXJzLm1hcCgobSkgPT4gKFxuICAgICAgICAgICAgICAgICAgICA8ZGl2XG4gICAgICAgICAgICAgICAgICAgICAga2V5PXttLmlkfVxuICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMSBweS0xLjUgcHgtMS41IGhvdmVyOmJnLVt2YXIoLS1hdnAtc3VyZmFjZS1ob3ZlcildLzYwIHJvdW5kZWQtbWQgdGV4dC14c1wiXG4gICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICB7ZWRpdGluZ01hcmtlcklkID09PSBtLmlkID8gKFxuICAgICAgICAgICAgICAgICAgICAgICAgPGZvcm1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgZmxleC0xXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgb25TdWJtaXQ9eyhlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvblJlbmFtZU1hcmtlciAmJiBlZGl0aW5nTWFya2VyTGFiZWwudHJpbSgpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvblJlbmFtZU1hcmtlcihtLmlkLCBlZGl0aW5nTWFya2VyTGFiZWwudHJpbSgpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0RWRpdGluZ01hcmtlcklkKG51bGwpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlPVwidGV4dFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXV0b0ZvY3VzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWU9e2VkaXRpbmdNYXJrZXJMYWJlbH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNoYW5nZT17KGUpID0+IHNldEVkaXRpbmdNYXJrZXJMYWJlbChlLnRhcmdldC52YWx1ZSl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiYXZwLWlucHV0IGgtWzI2cHhdIGZsZXgtMSBtaW4tdy0wIHRleHQteHNcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJzdWJtaXRcIiBjbGFzc05hbWU9XCJhdnAtYnRuIGF2cC1idG4tc20gYXZwLWJ0bi10b25hbFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9ir2KjYqicgOiAnU2F2ZSd9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgPC9mb3JtPlxuICAgICAgICAgICAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgICAgICAgICAgICA8PlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb25DbGljaz17KCkgPT4gb25TZWVrU2VjKG0uc3RhcnRTZWMpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImZsZXgtMSBtaW4tdy0wIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiB0ZXh0LXN0YXJ0IHRleHQtW3ZhcigtLWF2cC10ZXh0KV0gaG92ZXI6dGV4dC1bdmFyKC0tYXZwLWFjY2VudC10ZXh0KV0gY3Vyc29yLXBvaW50ZXJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3NOYW1lPVwidHJ1bmNhdGUgZm9udC1tZWRpdW1cIj57bS5sYWJlbH08L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJkaVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlyPVwibHRyXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImF2cC1iaWRpLW51bSB0ZXh0LVsxMC41cHhdIHRleHQtW3ZhcigtLWF2cC10ZXh0LW11dGVkKV0gc2hyaW5rLTBcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtmb3JtYXRUaW1lY29kZShzZWNvbmRzVG9GbGlja3MobS5zdGFydFNlYykpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvYmRpPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IHNocmluay0wXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge29uUmVuYW1lTWFya2VyICYmIChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRFZGl0aW5nTWFya2VySWQobS5pZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0RWRpdGluZ01hcmtlckxhYmVsKG0ubGFiZWwpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gYNiq2LrbjNuM2LEg2YbYp9mFICR7bS5sYWJlbH1gIDogYFJlbmFtZSAke20ubGFiZWx9YH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiYXZwLWJ0bi1pY29uIGF2cC1idG4taWNvbi1zbVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxFZGl0MyBjbGFzc05hbWU9XCJ3LTMgaC0zXCIgc3Ryb2tlV2lkdGg9ezEuNzV9IC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtvbkRlbGV0ZU1hcmtlciAmJiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiBvbkRlbGV0ZU1hcmtlcihtLmlkKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJpYS1sYWJlbD17aXNGYSA/IGDYrdiw2YEgJHttLmxhYmVsfWAgOiBgRGVsZXRlICR7bS5sYWJlbH1gfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJhdnAtYnRuLWljb24gYXZwLWJ0bi1pY29uLXNtIGF2cC1idG4tZGFuZ2VyLWdob3N0XCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRyYXNoMiBjbGFzc05hbWU9XCJ3LTMgaC0zXCIgc3Ryb2tlV2lkdGg9ezEuNzV9IC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApfVxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvPlxuICAgICAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgKSl9XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICl9XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgey8qIFVuZG8gU3RhY2sgSGlzdG9yeSAqL31cbiAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwic3BhY2UteS0xLjUgcHQtMi41IGJvcmRlci10IGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildXCI+XG4gICAgICAgICAgICAgIDxoMyBjbGFzc05hbWU9XCJweC0xIHRleHQtWzExLjVweF0gZm9udC1zZW1pYm9sZCB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXVwiPlxuICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9iq2KfYsduM2K7ahtmHINiq2LrbjNuM2LHYp9iqJyA6ICdFZGl0IEhpc3RvcnknfVxuICAgICAgICAgICAgICA8L2gzPlxuICAgICAgICAgICAgICB7aGlzdG9yeS5sZW5ndGggPT09IDAgPyAoXG4gICAgICAgICAgICAgICAgPHAgY2xhc3NOYW1lPVwicHgtMSB0ZXh0LVsxMS41cHhdIHRleHQtW3ZhcigtLWF2cC10ZXh0LW11dGVkKV1cIj5cbiAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9iq2LHYp9qp2YbYtCDYqtiv2YjbjNmG24wg2KvYqNiqINmG2LTYr9mHINin2LPYqi4nIDogJ05vIGVkaXQgdHJhbnNhY3Rpb25zIHlldC4nfVxuICAgICAgICAgICAgICAgIDwvcD5cbiAgICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgICA8dWwgY2xhc3NOYW1lPVwiZGl2aWRlLXkgZGl2aWRlLVt2YXIoLS1hdnAtYm9yZGVyLXN1YnRsZSldXCI+XG4gICAgICAgICAgICAgICAgICB7aGlzdG9yeVxuICAgICAgICAgICAgICAgICAgICAuc2xpY2UoKVxuICAgICAgICAgICAgICAgICAgICAucmV2ZXJzZSgpXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoKHR4KSA9PiAoXG4gICAgICAgICAgICAgICAgICAgICAgPGxpXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk9e3R4Lm9wZXJhdGlvbklkfVxuICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwicHktMS41IHB4LTEuNSB0ZXh0LVsxMXB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTJcIlxuICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cInRydW5jYXRlXCI+e3R4LmRlc2NyaXB0aW9ufTwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cImZvbnQtbW9ubyB0ZXh0LVsxMHB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1mYWludCldIHNocmluay0wXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHt0eC50eXBlfVxuICAgICAgICAgICAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICAgIDwvbGk+XG4gICAgICAgICAgICAgICAgICAgICkpfVxuICAgICAgICAgICAgICAgIDwvdWw+XG4gICAgICAgICAgICAgICl9XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cbiAgICAgIDwvZGl2PlxuICAgIDwvYXNpZGU+XG4gICk7XG59O1xuIl19