const React = __vite__cjsImport0_react; const useMemo = __vite__cjsImport0_react["useMemo"]; const useRef = __vite__cjsImport0_react["useRef"]; const useState = __vite__cjsImport0_react["useState"];const _jsxDEV = __vite__cjsImport3_react_jsxDevRuntime["jsxDEV"];import __vite__cjsImport0_react from "/node_modules/.vite/deps/react.js?v=dad653c5";
import { AlertCircle, CheckCircle2, Clock, Copy, Edit3, FileAudio, FolderOpen, Languages, LayoutGrid, List, Loader2, Moon, MoreVertical, Play, Plus, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Square, Sun, Trash2, Wand2 } from "/node_modules/.vite/deps/lucide-react.js?v=dad653c5";
import { filterAndSortProjects } from "/src/projects/projectLibraryLogic.ts";
var _jsxFileName = "/app/applet/src/components/ProjectsHubView.tsx";
import __vite__cjsImport3_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=dad653c5";
function formatAudioDurationClock(sec) {
	const safe = Math.max(0, Math.round(sec || 0));
	const mins = Math.floor(safe / 60);
	const secs = safe % 60;
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
function formatRelativeModifiedTime(updatedAtMs, locale) {
	const diffSec = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1e3));
	if (diffSec < 60) return locale === "fa" ? "چند لحظه پیش" : "Just now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return locale === "fa" ? `${diffMin} دقیقه پیش` : `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return locale === "fa" ? `${diffHr} ساعت پیش` : `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	return locale === "fa" ? `${diffDay} روز پیش` : `${diffDay}d ago`;
}
function formatProjectStatusLabel(status, locale) {
	switch (status) {
		case "completed": return locale === "fa" ? "تکمیل‌شده" : "Completed";
		case "review": return locale === "fa" ? "آماده بازبینی" : "In Review";
		case "editing":
		default: return locale === "fa" ? "در حال تدوین" : "Editing";
	}
}
function getStatusBadgeClasses(status) {
	switch (status) {
		case "review": return "bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] border-[var(--avp-brand)]/25";
		case "completed": return "bg-[var(--avp-success)]/15 text-[var(--avp-success)] border-[var(--avp-success)]/30";
		case "editing":
		default: return "bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)] border-[var(--avp-border)]";
	}
}
export const ProjectsHubView = ({ locale, theme, projects, isLoading, errorMessage, corruptedCount, onRetryLoad, onOpenNewProjectModal, onOpenProject, onOpenSampleStudio, onRenameProject, onDuplicateProject, onDeleteProject, onToggleTheme, onToggleLocale, onOpenSettings, onOpenLifecycleModal }) => {
	const isFa = locale === "fa";
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState("all");
	const [sortBy, setSortBy] = useState("updatedAt");
	const [viewMode, setViewMode] = useState("grid");
	const [openMenuId, setOpenMenuId] = useState(null);
	const [renamingId, setRenamingId] = useState(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [confirmDeleteItem, setConfirmDeleteItem] = useState(null);
	const [isDeleting, setIsDeleting] = useState(false);
	const [previewPlayingId, setPreviewPlayingId] = useState(null);
	const previewTimerRef = useRef(null);
	const previewAudioCtxRef = useRef(null);
	const stopPreviewAudio = () => {
		if (previewTimerRef.current) {
			window.clearTimeout(previewTimerRef.current);
			previewTimerRef.current = null;
		}
		if (previewAudioCtxRef.current) {
			previewAudioCtxRef.current.close().catch(() => {});
			previewAudioCtxRef.current = null;
		}
		setPreviewPlayingId(null);
	};
	const handleToggleQuickPreview = (e, item) => {
		e.stopPropagation();
		if (previewPlayingId === item.id) {
			stopPreviewAudio();
			return;
		}
		stopPreviewAudio();
		setPreviewPlayingId(item.id);
		try {
			const AudioCtx = window.AudioContext || window.webkitAudioContext;
			if (AudioCtx) {
				const ctx = new AudioCtx();
				previewAudioCtxRef.current = ctx;
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.setValueAtTime(196, ctx.currentTime);
				const peaks = item.waveformPreviewPeaks?.length ? item.waveformPreviewPeaks : [
					.35,
					.7,
					.45,
					.85,
					.5
				];
				gain.gain.setValueAtTime(.001, ctx.currentTime);
				peaks.slice(0, 12).forEach((p, idx) => {
					const t = ctx.currentTime + idx * .14;
					gain.gain.exponentialRampToValueAtTime(Math.max(.004, Math.min(.06, p * .06)), t);
					osc.frequency.setValueAtTime(175 + Math.round(p * 110), t);
				});
				gain.gain.exponentialRampToValueAtTime(1e-4, ctx.currentTime + 1.75);
				osc.connect(gain);
				gain.connect(ctx.destination);
				osc.start();
				osc.stop(ctx.currentTime + 1.8);
			}
		} catch {}
		previewTimerRef.current = window.setTimeout(() => {
			stopPreviewAudio();
		}, 1800);
	};
	const filteredProjects = useMemo(() => {
		return filterAndSortProjects(projects, {
			query: searchQuery,
			filter: statusFilter,
			sortBy
		});
	}, [
		projects,
		searchQuery,
		statusFilter,
		sortBy
	]);
	const handleStartRename = (item) => {
		setOpenMenuId(null);
		setRenamingId(item.id);
		setRenameDraft(item.name);
	};
	const handleCommitRename = async (projectId) => {
		const clean = renameDraft.trim();
		setRenamingId(null);
		if (!clean) return;
		await onRenameProject(projectId, clean);
	};
	const handleConfirmDelete = async () => {
		if (!confirmDeleteItem) return;
		setIsDeleting(true);
		try {
			await onDeleteProject(confirmDeleteItem.id);
			setConfirmDeleteItem(null);
		} finally {
			setIsDeleting(false);
		}
	};
	return /* @__PURE__ */ _jsxDEV("div", {
		dir: isFa ? "rtl" : "ltr",
		className: "min-h-screen flex flex-col bg-[var(--avp-bg)] text-[var(--avp-text)]",
		onClick: () => setOpenMenuId(null),
		children: [
			/* @__PURE__ */ _jsxDEV("header", {
				className: "sticky top-0 z-30 h-[var(--avp-header-h)] bg-[var(--avp-surface)] border-b border-[var(--avp-border)] px-3 sm:px-5 flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ _jsxDEV("div", {
					className: "flex items-center gap-2.5 min-w-0",
					children: [/* @__PURE__ */ _jsxDEV("div", {
						className: "w-7 h-7 rounded-[var(--avp-radius-sm)] bg-[var(--avp-brand)] text-white flex items-center justify-center shadow-[var(--avp-shadow-xs)] shrink-0",
						children: /* @__PURE__ */ _jsxDEV("svg", {
							viewBox: "0 0 24 24",
							className: "w-4 h-4",
							fill: "none",
							"aria-hidden": "true",
							children: /* @__PURE__ */ _jsxDEV("path", {
								d: "M4 12.5h2.2l1.8-5.5 2.6 10 2.4-7.5 1.8 4.2 1.7-1.2H20",
								stroke: "currentColor",
								strokeWidth: "2.1",
								strokeLinecap: "round",
								strokeLinejoin: "round"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 235,
								columnNumber: 15
							}, this)
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 234,
							columnNumber: 13
						}, this)
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 233,
						columnNumber: 11
					}, this), /* @__PURE__ */ _jsxDEV("div", {
						className: "flex items-center gap-2 min-w-0",
						children: [/* @__PURE__ */ _jsxDEV("h1", {
							className: "text-[13px] font-bold tracking-tight text-[var(--avp-text)] leading-none",
							children: isFa ? "آواپرداز" : "Avapardaz"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 245,
							columnNumber: 13
						}, this), /* @__PURE__ */ _jsxDEV("span", {
							className: "hidden sm:inline-block text-[11px] px-2 py-0.5 rounded-[var(--avp-radius-xs)] bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)] border border-[var(--avp-border-subtle)] font-medium",
							children: isFa ? "استودیوی تدوین گفتار و پادکست" : "Persian Speech & Podcast Studio"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 248,
							columnNumber: 13
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 244,
						columnNumber: 11
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 232,
					columnNumber: 9
				}, this), /* @__PURE__ */ _jsxDEV("div", {
					className: "flex items-center gap-2",
					children: [/* @__PURE__ */ _jsxDEV("button", {
						type: "button",
						"data-testid": "btn-new-project",
						onClick: onOpenNewProjectModal,
						className: "avp-btn-primary text-xs font-semibold cursor-pointer shadow-[var(--avp-shadow-xs)]",
						children: [/* @__PURE__ */ _jsxDEV(Plus, { className: "w-3.5 h-3.5" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 261,
							columnNumber: 13
						}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "پروژه جدید" : "New Project" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 262,
							columnNumber: 13
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 255,
						columnNumber: 11
					}, this), /* @__PURE__ */ _jsxDEV("div", {
						className: "flex items-center gap-0.5 p-0.5 rounded-[var(--avp-radius-sm)] border border-[var(--avp-border)] bg-[var(--avp-surface-2)]",
						children: [
							/* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								onClick: onToggleLocale,
								title: isFa ? "Switch to English" : "تغییر به فارسی",
								"aria-label": isFa ? "تغییر زبان به انگلیسی" : "Switch language to Persian",
								className: "h-6 px-1.5 rounded-[var(--avp-radius-xs)] text-[10px] font-semibold text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center gap-1 cursor-pointer transition-colors",
								children: [/* @__PURE__ */ _jsxDEV(Languages, { className: "w-3 h-3" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 274,
									columnNumber: 15
								}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "EN" : "FA" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 275,
									columnNumber: 15
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 267,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								onClick: onToggleTheme,
								title: theme === "dark" ? isFa ? "حالت روشن" : "Light mode" : isFa ? "حالت تیره" : "Dark mode",
								"aria-label": isFa ? "تغییر تم روشن و تیره" : "Toggle theme",
								className: "w-6 h-6 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer transition-colors",
								children: theme === "dark" ? /* @__PURE__ */ _jsxDEV(Sun, { className: "w-3.5 h-3.5 text-amber-400" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 294,
									columnNumber: 17
								}, this) : /* @__PURE__ */ _jsxDEV(Moon, { className: "w-3.5 h-3.5" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 296,
									columnNumber: 17
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 278,
								columnNumber: 13
							}, this),
							onOpenLifecycleModal && /* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								onClick: onOpenLifecycleModal,
								title: isFa ? "سلامت سیستم و مدل‌های آفلاین" : "System Health & Local Models",
								"aria-label": isFa ? "سلامت سیستم و مدل‌های آفلاین" : "System Health & Local Models",
								className: "w-6 h-6 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer transition-colors",
								children: /* @__PURE__ */ _jsxDEV(ShieldCheck, { className: "w-3.5 h-3.5 text-[var(--avp-brand)]" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 308,
									columnNumber: 17
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 301,
								columnNumber: 15
							}, this),
							/* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								"data-testid": "btn-open-settings-hub",
								onClick: onOpenSettings,
								title: isFa ? "تنظیمات" : "Settings",
								"aria-label": isFa ? "تنظیمات" : "Settings",
								className: "w-6 h-6 rounded-[var(--avp-radius-xs)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer transition-colors",
								children: /* @__PURE__ */ _jsxDEV(Settings, { className: "w-3.5 h-3.5" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 320,
									columnNumber: 15
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 312,
								columnNumber: 13
							}, this)
						]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 266,
						columnNumber: 11
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 254,
					columnNumber: 9
				}, this)]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 231,
				columnNumber: 7
			}, this),
			/* @__PURE__ */ _jsxDEV("main", {
				className: "flex-1 max-w-[1280px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6",
				children: [
					corruptedCount > 0 && /* @__PURE__ */ _jsxDEV("div", {
						role: "status",
						className: "p-3.5 rounded-xl border border-[var(--avp-warning)]/40 bg-[var(--avp-accent-soft)]/50 text-xs flex items-center justify-between gap-3",
						children: /* @__PURE__ */ _jsxDEV("div", {
							className: "flex items-center gap-2",
							children: [/* @__PURE__ */ _jsxDEV(AlertCircle, { className: "w-4 h-4 text-[var(--avp-warning)] shrink-0" }, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 335,
								columnNumber: 15
							}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? `${corruptedCount} پروژه قدیمی یا آسیب‌دیده نادیده گرفته شد تا عملکرد برنامه مختل نشود.` : `${corruptedCount} corrupted project entry was skipped safely.` }, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 336,
								columnNumber: 15
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 334,
							columnNumber: 13
						}, this)
					}, void 0, false, {
						fileName: _jsxFileName,
						lineNumber: 330,
						columnNumber: 11
					}, this),
					isLoading && /* @__PURE__ */ _jsxDEV("div", {
						"data-testid": "projects-loading-state",
						className: "py-20 flex flex-col items-center justify-center gap-3 text-[var(--avp-text-secondary)]",
						children: [/* @__PURE__ */ _jsxDEV(Loader2, { className: "w-7 h-7 animate-spin text-[var(--avp-brand)]" }, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 351,
							columnNumber: 13
						}, this), /* @__PURE__ */ _jsxDEV("p", {
							className: "text-sm font-medium",
							children: isFa ? "در حال بارگذاری پروژه‌ها..." : "Loading your projects..."
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 352,
							columnNumber: 13
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 347,
						columnNumber: 11
					}, this),
					!isLoading && errorMessage && /* @__PURE__ */ _jsxDEV("div", {
						"data-testid": "projects-error-state",
						className: "p-6 rounded-2xl border border-[var(--avp-error)]/40 bg-[var(--avp-surface)] text-center space-y-3",
						children: [
							/* @__PURE__ */ _jsxDEV(AlertCircle, { className: "w-8 h-8 text-[var(--avp-error)] mx-auto" }, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 364,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("h2", {
								className: "text-base font-bold",
								children: isFa ? "بارگذاری فهرست پروژه‌ها ناموفق بود" : "Failed to load projects"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 365,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("p", {
								className: "text-xs text-[var(--avp-text-secondary)] max-w-md mx-auto",
								children: errorMessage
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 368,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								onClick: onRetryLoad,
								className: "h-9 px-4 rounded-xl bg-[var(--avp-brand)] text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer",
								children: [/* @__PURE__ */ _jsxDEV(RefreshCw, { className: "w-3.5 h-3.5" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 376,
									columnNumber: 15
								}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "تلاش دوباره" : "Retry" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 377,
									columnNumber: 15
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 371,
								columnNumber: 13
							}, this)
						]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 360,
						columnNumber: 11
					}, this),
					!isLoading && !errorMessage && projects.length === 0 && /* @__PURE__ */ _jsxDEV("div", {
						"data-testid": "projects-empty-state",
						className: "rounded-3xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-7 sm:p-11 shadow-[var(--avp-shadow-sm)] text-center max-w-3xl mx-auto my-6 space-y-6",
						children: [
							/* @__PURE__ */ _jsxDEV("div", {
								className: "w-16 h-16 rounded-2xl bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] flex items-center justify-center mx-auto",
								children: /* @__PURE__ */ _jsxDEV(FileAudio, { className: "w-8 h-8" }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 389,
									columnNumber: 15
								}, this)
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 388,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("div", {
								className: "space-y-2 max-w-xl mx-auto",
								children: [/* @__PURE__ */ _jsxDEV("h2", {
									className: "text-xl sm:text-2xl font-bold text-[var(--avp-text)]",
									children: isFa ? "به استودیوی تدوین گفتار آواپرداز خوش آمدید" : "Welcome to Avapardaz Speech Editing Studio"
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 393,
									columnNumber: 15
								}, this), /* @__PURE__ */ _jsxDEV("p", {
									className: "text-sm text-[var(--avp-text-secondary)] leading-relaxed",
									children: isFa ? "فایل صوتی گفتار یا پادکست خود را وارد کنید، متن زمان‌بندی‌شده را ببینید، تپق‌ها و مکث‌های اضافه را با یک کلیک اصلاح کنید و فایل صوتی تمیز تحویل بگیرید." : "Import your Persian speech or podcast audio, inspect the timed transcript, clean up disfluencies and pauses with one click, and export polished audio."
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 398,
									columnNumber: 15
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 392,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("div", {
								className: "flex flex-wrap items-center justify-center gap-3 pt-1",
								children: [/* @__PURE__ */ _jsxDEV("button", {
									type: "button",
									"data-testid": "btn-empty-create-project",
									onClick: onOpenNewProjectModal,
									className: "h-11 px-6 rounded-xl bg-[var(--avp-brand)] hover:bg-[var(--avp-brand-hover)] text-white text-sm font-semibold inline-flex items-center gap-2 shadow-[var(--avp-shadow-xs)] cursor-pointer transition-colors",
									children: [/* @__PURE__ */ _jsxDEV(Plus, { className: "w-4 h-4" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 412,
										columnNumber: 17
									}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "ایجاد اولین پروژه با فایل صوتی" : "Create First Project with Audio" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 413,
										columnNumber: 17
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 406,
									columnNumber: 15
								}, this), /* @__PURE__ */ _jsxDEV("button", {
									type: "button",
									"data-testid": "btn-open-sample-studio",
									onClick: onOpenSampleStudio,
									className: "h-11 px-5 rounded-xl border border-[var(--avp-border)] bg-[var(--avp-surface-2)] hover:bg-[var(--avp-hover)] text-[var(--avp-text)] text-xs font-medium inline-flex items-center gap-2 cursor-pointer transition-colors",
									children: [/* @__PURE__ */ _jsxDEV(Wand2, { className: "w-4 h-4 text-[var(--avp-brand)]" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 426,
										columnNumber: 17
									}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "آزمایش با نمونه صوتی آماده" : "Try with Sample Persian Audio" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 427,
										columnNumber: 17
									}, this)]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 420,
									columnNumber: 15
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 405,
								columnNumber: 13
							}, this),
							/* @__PURE__ */ _jsxDEV("div", {
								className: "grid grid-cols-1 sm:grid-cols-4 gap-3 pt-4 text-start border-t border-[var(--avp-border-subtle)]",
								children: [
									{
										num: isFa ? "۱" : "1",
										title: isFa ? "بارگذاری فایل صوتی" : "Import Audio",
										desc: isFa ? "پشتیبانی از WAV، MP3، M4A، FLAC و OGG" : "Supports WAV, MP3, M4A, FLAC & OGG"
									},
									{
										num: isFa ? "۲" : "2",
										title: isFa ? "تبدیل گفتار به متن" : "Transcribe Speech",
										desc: isFa ? "استخراج کلمات زمان‌بندی‌شده فارسی" : "Word-level timed Persian transcript"
									},
									{
										num: isFa ? "۳" : "3",
										title: isFa ? "پیشنهادهای هوشمند تدوین" : "Smart Edit Suggestions",
										desc: isFa ? "حذف مکث‌های طولانی، تپق‌ها و تکرارها" : "Clean long pauses, fillers & repeats"
									},
									{
										num: isFa ? "۴" : "4",
										title: isFa ? "خروجی نهایی تمیز" : "Polished Export",
										desc: isFa ? "دریافت فایل صوتی تدوین‌شده با بلندی استاندارد" : "Export mastered WAV or FLAC audio"
									}
								].map((step) => /* @__PURE__ */ _jsxDEV("div", {
									className: "p-3.5 rounded-2xl bg-[var(--avp-bg)] border border-[var(--avp-border-subtle)] space-y-1",
									children: [
										/* @__PURE__ */ _jsxDEV("span", {
											className: "w-6 h-6 rounded-lg bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] text-xs font-bold inline-flex items-center justify-center",
											children: step.num
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 469,
											columnNumber: 19
										}, this),
										/* @__PURE__ */ _jsxDEV("div", {
											className: "text-xs font-bold text-[var(--avp-text)] pt-1",
											children: step.title
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 472,
											columnNumber: 19
										}, this),
										/* @__PURE__ */ _jsxDEV("div", {
											className: "text-[11px] text-[var(--avp-text-secondary)] leading-relaxed",
											children: step.desc
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 473,
											columnNumber: 19
										}, this)
									]
								}, step.num, true, {
									fileName: _jsxFileName,
									lineNumber: 465,
									columnNumber: 17
								}, this))
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 434,
								columnNumber: 13
							}, this)
						]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 384,
						columnNumber: 11
					}, this),
					!isLoading && !errorMessage && projects.length > 0 && /* @__PURE__ */ _jsxDEV("div", {
						className: "space-y-5",
						children: [/* @__PURE__ */ _jsxDEV("div", {
							className: "flex flex-col md:flex-row md:items-center justify-between gap-3",
							children: [/* @__PURE__ */ _jsxDEV("div", { children: [/* @__PURE__ */ _jsxDEV("h2", {
								className: "text-lg font-bold flex items-center gap-2",
								children: [
									/* @__PURE__ */ _jsxDEV(FolderOpen, { className: "w-5 h-5 text-[var(--avp-brand)]" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 489,
										columnNumber: 19
									}, this),
									/* @__PURE__ */ _jsxDEV("span", { children: isFa ? "پروژه‌های شما" : "Your Projects" }, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 490,
										columnNumber: 19
									}, this),
									/* @__PURE__ */ _jsxDEV("span", {
										className: "text-xs font-medium px-2 py-0.5 rounded-full bg-[var(--avp-surface-2)] text-[var(--avp-text-secondary)]",
										children: projects.length
									}, void 0, false, {
										fileName: _jsxFileName,
										lineNumber: 491,
										columnNumber: 19
									}, this)
								]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 488,
								columnNumber: 17
							}, this), /* @__PURE__ */ _jsxDEV("p", {
								className: "text-xs text-[var(--avp-text-secondary)] mt-0.5",
								children: isFa ? "برای ادامه تدوین روی هر پروژه کلیک کنید یا پروژه جدیدی بسازید." : "Click any project to resume editing in the studio or create a new project."
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 495,
								columnNumber: 17
							}, this)] }, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 487,
								columnNumber: 15
							}, this), /* @__PURE__ */ _jsxDEV("div", {
								className: "flex flex-wrap items-center gap-2",
								children: [
									/* @__PURE__ */ _jsxDEV("div", {
										className: "relative flex-1 sm:flex-initial sm:w-64",
										children: [/* @__PURE__ */ _jsxDEV(Search, { className: "w-3.5 h-3.5 text-[var(--avp-text-muted)] absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" }, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 505,
											columnNumber: 19
										}, this), /* @__PURE__ */ _jsxDEV("input", {
											type: "search",
											"data-testid": "projects-search-input",
											value: searchQuery,
											onChange: (e) => setSearchQuery(e.target.value),
											placeholder: isFa ? "جستجو در نام پروژه یا فایل..." : "Search project or file...",
											className: "w-full h-9 ps-8 pe-3 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)] placeholder:text-[var(--avp-text-muted)] focus:outline-none focus:border-[var(--avp-brand)]"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 506,
											columnNumber: 19
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 504,
										columnNumber: 17
									}, this),
									/* @__PURE__ */ _jsxDEV("select", {
										"aria-label": isFa ? "فیلتر وضعیت پروژه" : "Filter by status",
										"data-testid": "projects-status-filter",
										value: statusFilter,
										onChange: (e) => setStatusFilter(e.target.value),
										className: "h-9 px-3 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)] cursor-pointer",
										children: [
											/* @__PURE__ */ _jsxDEV("option", {
												value: "all",
												children: isFa ? "همه وضعیت‌ها" : "All statuses"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 525,
												columnNumber: 19
											}, this),
											/* @__PURE__ */ _jsxDEV("option", {
												value: "recent",
												children: isFa ? "اخیر" : "Recent"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 526,
												columnNumber: 19
											}, this),
											/* @__PURE__ */ _jsxDEV("option", {
												value: "editing",
												children: isFa ? "در حال تدوین" : "Editing & Review"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 527,
												columnNumber: 19
											}, this),
											/* @__PURE__ */ _jsxDEV("option", {
												value: "completed",
												children: isFa ? "تکمیل‌شده" : "Completed"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 528,
												columnNumber: 19
											}, this)
										]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 518,
										columnNumber: 17
									}, this),
									/* @__PURE__ */ _jsxDEV("select", {
										"aria-label": isFa ? "مرتب‌سازی پروژه‌ها" : "Sort projects",
										"data-testid": "projects-sort-select",
										value: sortBy,
										onChange: (e) => setSortBy(e.target.value),
										className: "h-9 px-3 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] text-xs text-[var(--avp-text)] cursor-pointer",
										children: [
											/* @__PURE__ */ _jsxDEV("option", {
												value: "updatedAt",
												children: isFa ? "آخرین ویرایش" : "Last modified"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 538,
												columnNumber: 19
											}, this),
											/* @__PURE__ */ _jsxDEV("option", {
												value: "lastOpenedAt",
												children: isFa ? "آخرین بازدید" : "Last opened"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 541,
												columnNumber: 19
											}, this),
											/* @__PURE__ */ _jsxDEV("option", {
												value: "name",
												children: isFa ? "نام (الفبایی)" : "Name (A–Z)"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 544,
												columnNumber: 19
											}, this)
										]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 531,
										columnNumber: 17
									}, this),
									/* @__PURE__ */ _jsxDEV("div", {
										className: "avp-segmented",
										children: [/* @__PURE__ */ _jsxDEV("button", {
											type: "button",
											"data-testid": "btn-projects-view-grid",
											onClick: () => setViewMode("grid"),
											"aria-pressed": viewMode === "grid",
											title: isFa ? "نمای کارتی" : "Card Grid View",
											className: "avp-segmented-item cursor-pointer",
											children: [/* @__PURE__ */ _jsxDEV(LayoutGrid, { className: "w-3.5 h-3.5" }, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 557,
												columnNumber: 21
											}, this), /* @__PURE__ */ _jsxDEV("span", {
												className: "hidden sm:inline",
												children: isFa ? "کارت" : "Grid"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 558,
												columnNumber: 21
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 549,
											columnNumber: 19
										}, this), /* @__PURE__ */ _jsxDEV("button", {
											type: "button",
											"data-testid": "btn-projects-view-table",
											onClick: () => setViewMode("table"),
											"aria-pressed": viewMode === "table",
											title: isFa ? "نمای جدولی فشرده" : "Compact Table View",
											className: "avp-segmented-item cursor-pointer",
											children: [/* @__PURE__ */ _jsxDEV(List, { className: "w-3.5 h-3.5" }, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 568,
												columnNumber: 21
											}, this), /* @__PURE__ */ _jsxDEV("span", {
												className: "hidden sm:inline",
												children: isFa ? "جدول" : "Table"
											}, void 0, false, {
												fileName: _jsxFileName,
												lineNumber: 569,
												columnNumber: 21
											}, this)]
										}, void 0, true, {
											fileName: _jsxFileName,
											lineNumber: 560,
											columnNumber: 19
										}, this)]
									}, void 0, true, {
										fileName: _jsxFileName,
										lineNumber: 548,
										columnNumber: 17
									}, this)
								]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 503,
								columnNumber: 15
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 486,
							columnNumber: 13
						}, this), filteredProjects.length === 0 ? /* @__PURE__ */ _jsxDEV("div", {
							className: "rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-10 text-center space-y-2",
							children: [/* @__PURE__ */ _jsxDEV("p", {
								className: "text-sm font-semibold",
								children: isFa ? "هیچ پروژه‌ای با جستجوی شما مطابقت ندارد" : "No matching projects found"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 578,
								columnNumber: 17
							}, this), /* @__PURE__ */ _jsxDEV("button", {
								type: "button",
								onClick: () => {
									setSearchQuery("");
									setStatusFilter("all");
								},
								className: "text-xs text-[var(--avp-brand)] hover:underline cursor-pointer",
								children: isFa ? "پاک کردن فیلترها" : "Reset filters"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 583,
								columnNumber: 17
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 577,
							columnNumber: 15
						}, this) : viewMode === "grid" ? /* @__PURE__ */ _jsxDEV(
							"div",
							/* Project Cards Grid (3-Column Responsive Desktop Grid) */
							{
								"data-testid": "projects-grid",
								className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4",
								children: filteredProjects.map((item) => {
									const isMenuOpen = openMenuId === item.id;
									const isRenaming = renamingId === item.id;
									const isPlayingPreview = previewPlayingId === item.id;
									const extBadge = (item.sourceFileName.split(".").pop() || "WAV").toUpperCase();
									const peaks = item.waveformPreviewPeaks?.length ? item.waveformPreviewPeaks : [
										.3,
										.55,
										.4,
										.8,
										.5,
										.65,
										.42,
										.74,
										.51,
										.88,
										.36,
										.62
									];
									return /* @__PURE__ */ _jsxDEV("article", {
										"data-testid": `project-card-${item.id}`,
										onClick: () => {
											if (!isRenaming) onOpenProject(item.id);
										},
										className: "group relative rounded-[var(--avp-radius-lg)] border border-[var(--avp-border)] bg-[var(--avp-surface)] hover:border-[var(--avp-brand)]/60 p-4 shadow-[var(--avp-shadow-xs)] hover:shadow-[var(--avp-shadow-sm)] transition-all flex flex-col justify-between gap-4 cursor-pointer",
										children: [
											/* @__PURE__ */ _jsxDEV("div", {
												className: "flex items-start justify-between gap-2",
												children: [/* @__PURE__ */ _jsxDEV("span", {
													className: `inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-0.5 rounded-full border ${getStatusBadgeClasses(item.status)}`,
													children: [
														item.status === "review" && /* @__PURE__ */ _jsxDEV(Sparkles, { className: "w-3 h-3" }, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 628,
															columnNumber: 29
														}, this),
														item.status === "completed" && /* @__PURE__ */ _jsxDEV(CheckCircle2, { className: "w-3 h-3" }, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 631,
															columnNumber: 29
														}, this),
														formatProjectStatusLabel(item.status, locale)
													]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 622,
													columnNumber: 25
												}, this), /* @__PURE__ */ _jsxDEV("div", {
													className: "relative",
													onClick: (e) => {
														e.stopPropagation();
													},
													children: [/* @__PURE__ */ _jsxDEV("button", {
														type: "button",
														"data-testid": `project-menu-btn-${item.id}`,
														"aria-label": isFa ? "عملیات پروژه" : "Project actions",
														onClick: () => setOpenMenuId(isMenuOpen ? null : item.id),
														className: "w-7 h-7 rounded-[var(--avp-radius-sm)] text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] hover:text-[var(--avp-text)] inline-flex items-center justify-center cursor-pointer",
														children: /* @__PURE__ */ _jsxDEV(MoreVertical, { className: "w-4 h-4" }, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 651,
															columnNumber: 29
														}, this)
													}, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 642,
														columnNumber: 27
													}, this), isMenuOpen && /* @__PURE__ */ _jsxDEV("div", {
														className: "absolute end-0 mt-1 w-44 rounded-[var(--avp-radius-md)] border border-[var(--avp-border)] bg-[var(--avp-surface)] shadow-[var(--avp-shadow-md)] py-1 z-20 text-xs",
														children: [
															/* @__PURE__ */ _jsxDEV("button", {
																type: "button",
																"data-testid": `project-rename-btn-${item.id}`,
																onClick: () => handleStartRename(item),
																className: "w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer",
																children: [/* @__PURE__ */ _jsxDEV(Edit3, { className: "w-3.5 h-3.5 text-[var(--avp-text-secondary)]" }, void 0, false, {
																	fileName: _jsxFileName,
																	lineNumber: 662,
																	columnNumber: 33
																}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "تغییر نام پروژه" : "Rename" }, void 0, false, {
																	fileName: _jsxFileName,
																	lineNumber: 663,
																	columnNumber: 33
																}, this)]
															}, void 0, true, {
																fileName: _jsxFileName,
																lineNumber: 656,
																columnNumber: 31
															}, this),
															/* @__PURE__ */ _jsxDEV("button", {
																type: "button",
																"data-testid": `project-duplicate-btn-${item.id}`,
																onClick: () => {
																	setOpenMenuId(null);
																	void onDuplicateProject(item.id);
																},
																className: "w-full px-3 py-2 text-start hover:bg-[var(--avp-hover)] flex items-center gap-2 cursor-pointer",
																children: [/* @__PURE__ */ _jsxDEV(Copy, { className: "w-3.5 h-3.5 text-[var(--avp-text-secondary)]" }, void 0, false, {
																	fileName: _jsxFileName,
																	lineNumber: 674,
																	columnNumber: 33
																}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "تکثیر پروژه" : "Duplicate" }, void 0, false, {
																	fileName: _jsxFileName,
																	lineNumber: 675,
																	columnNumber: 33
																}, this)]
															}, void 0, true, {
																fileName: _jsxFileName,
																lineNumber: 665,
																columnNumber: 31
															}, this),
															/* @__PURE__ */ _jsxDEV("div", { className: "my-1 border-t border-[var(--avp-border-subtle)]" }, void 0, false, {
																fileName: _jsxFileName,
																lineNumber: 677,
																columnNumber: 31
															}, this),
															/* @__PURE__ */ _jsxDEV("button", {
																type: "button",
																"data-testid": `project-delete-btn-${item.id}`,
																onClick: () => {
																	setOpenMenuId(null);
																	setConfirmDeleteItem(item);
																},
																className: "w-full px-3 py-2 text-start hover:bg-[var(--avp-error)]/10 text-[var(--avp-error)] flex items-center gap-2 cursor-pointer",
																children: [/* @__PURE__ */ _jsxDEV(Trash2, { className: "w-3.5 h-3.5" }, void 0, false, {
																	fileName: _jsxFileName,
																	lineNumber: 687,
																	columnNumber: 33
																}, this), /* @__PURE__ */ _jsxDEV("span", { children: isFa ? "حذف پروژه" : "Delete" }, void 0, false, {
																	fileName: _jsxFileName,
																	lineNumber: 688,
																	columnNumber: 33
																}, this)]
															}, void 0, true, {
																fileName: _jsxFileName,
																lineNumber: 678,
																columnNumber: 31
															}, this)
														]
													}, void 0, true, {
														fileName: _jsxFileName,
														lineNumber: 655,
														columnNumber: 29
													}, this)]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 636,
													columnNumber: 25
												}, this)]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 621,
												columnNumber: 23
											}, this),
											/* @__PURE__ */ _jsxDEV("div", {
												className: "space-y-1.5",
												children: [isRenaming ? /* @__PURE__ */ _jsxDEV("div", {
													className: "flex items-center gap-1.5",
													onClick: (e) => e.stopPropagation(),
													children: [/* @__PURE__ */ _jsxDEV("input", {
														type: "text",
														autoFocus: true,
														value: renameDraft,
														onChange: (e) => setRenameDraft(e.target.value),
														onKeyDown: (e) => {
															if (e.key === "Enter") void handleCommitRename(item.id);
															if (e.key === "Escape") setRenamingId(null);
														},
														className: "flex-1 h-8 px-2.5 rounded-lg border border-[var(--avp-brand)] bg-[var(--avp-bg)] text-xs font-semibold focus:outline-none"
													}, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 702,
														columnNumber: 29
													}, this), /* @__PURE__ */ _jsxDEV("button", {
														type: "button",
														onClick: () => void handleCommitRename(item.id),
														className: "h-8 px-2.5 rounded-lg bg-[var(--avp-brand)] text-white text-xs font-semibold cursor-pointer",
														children: isFa ? "ثبت" : "Save"
													}, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 713,
														columnNumber: 29
													}, this)]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 698,
													columnNumber: 27
												}, this) : /* @__PURE__ */ _jsxDEV("h3", {
													className: "text-base font-bold text-[var(--avp-text)] group-hover:text-[var(--avp-brand)] transition-colors line-clamp-1",
													children: item.name
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 722,
													columnNumber: 27
												}, this), /* @__PURE__ */ _jsxDEV("div", {
													className: "flex items-center justify-between gap-2 text-xs text-[var(--avp-text-secondary)]",
													children: [/* @__PURE__ */ _jsxDEV("div", {
														className: "flex items-center gap-1.5 truncate",
														children: [/* @__PURE__ */ _jsxDEV(FileAudio, { className: "w-3.5 h-3.5 text-[var(--avp-text-muted)] shrink-0" }, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 729,
															columnNumber: 29
														}, this), /* @__PURE__ */ _jsxDEV("span", {
															className: "truncate",
															dir: "ltr",
															children: item.sourceFileName
														}, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 730,
															columnNumber: 29
														}, this)]
													}, void 0, true, {
														fileName: _jsxFileName,
														lineNumber: 728,
														columnNumber: 27
													}, this), /* @__PURE__ */ _jsxDEV("span", {
														className: "shrink-0 font-mono text-[9.5px] px-1.5 py-0.5 rounded-[var(--avp-radius-xs)] bg-[var(--avp-surface-2)] border border-[var(--avp-border-subtle)] text-[var(--avp-text-secondary)]",
														children: [
															Math.round((item.sampleRate || 48e3) / 1e3),
															"kHz · ",
															extBadge
														]
													}, void 0, true, {
														fileName: _jsxFileName,
														lineNumber: 734,
														columnNumber: 27
													}, this)]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 727,
													columnNumber: 25
												}, this)]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 696,
												columnNumber: 23
											}, this),
											/* @__PURE__ */ _jsxDEV("div", {
												"aria-hidden": "true",
												className: "h-10 rounded-[var(--avp-radius-md)] bg-[var(--avp-bg)] border border-[var(--avp-border-subtle)] px-2.5 flex items-center gap-2",
												children: [/* @__PURE__ */ _jsxDEV("button", {
													type: "button",
													onClick: (e) => handleToggleQuickPreview(e, item),
													"data-testid": `project-preview-play-${item.id}`,
													title: isFa ? "پیش‌شنود سریع صوت پروژه" : "Quick Audio Audition",
													"aria-label": isFa ? "پیش‌شنود سریع صوت پروژه" : "Quick Audio Audition",
													className: `w-7 h-7 rounded-[var(--avp-radius-sm)] shrink-0 flex items-center justify-center border transition-all cursor-pointer ${isPlayingPreview ? "bg-[var(--avp-brand)] text-white border-[var(--avp-brand)] shadow-[var(--avp-shadow-xs)]" : "bg-[var(--avp-surface)] text-[var(--avp-brand)] border-[var(--avp-border)] hover:border-[var(--avp-brand)]/60 hover:bg-[var(--avp-brand-soft)]"}`,
													children: isPlayingPreview ? /* @__PURE__ */ _jsxDEV(Square, { className: "w-3 h-3 fill-current" }, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 758,
														columnNumber: 29
													}, this) : /* @__PURE__ */ _jsxDEV(Play, { className: "w-3 h-3 fill-current" }, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 760,
														columnNumber: 29
													}, this)
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 745,
													columnNumber: 25
												}, this), /* @__PURE__ */ _jsxDEV("div", {
													className: "flex-1 h-full flex items-center gap-[3px] overflow-hidden",
													children: peaks.slice(0, 28).map((amp, idx) => /* @__PURE__ */ _jsxDEV("span", {
														className: `flex-1 rounded-full transition-colors ${isPlayingPreview ? "bg-[var(--avp-brand)] animate-pulse" : "bg-[var(--avp-brand)]/35 group-hover:bg-[var(--avp-brand)]/65"}`,
														style: { height: `${Math.max(18, Math.min(92, Math.round(amp * 100)))}%` }
													}, idx, false, {
														fileName: _jsxFileName,
														lineNumber: 765,
														columnNumber: 29
													}, this))
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 763,
													columnNumber: 25
												}, this)]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 741,
												columnNumber: 23
											}, this),
											/* @__PURE__ */ _jsxDEV("div", {
												className: "pt-2 border-t border-[var(--avp-border-subtle)] flex items-center justify-between gap-2 text-[11px] text-[var(--avp-text-secondary)]",
												children: [/* @__PURE__ */ _jsxDEV("div", {
													className: "flex items-center gap-3",
													children: [/* @__PURE__ */ _jsxDEV("span", {
														className: "inline-flex items-center gap-1 font-mono",
														dir: "ltr",
														children: [/* @__PURE__ */ _jsxDEV(Clock, { className: "w-3 h-3" }, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 787,
															columnNumber: 29
														}, this), formatAudioDurationClock(item.durationSec)]
													}, void 0, true, {
														fileName: _jsxFileName,
														lineNumber: 783,
														columnNumber: 27
													}, this), /* @__PURE__ */ _jsxDEV("span", { children: item.wordCount > 0 ? isFa ? `${item.wordCount} کلمه` : `${item.wordCount} words` : isFa ? "بدون متن" : "No transcript" }, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 790,
														columnNumber: 27
													}, this)]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 782,
													columnNumber: 25
												}, this), /* @__PURE__ */ _jsxDEV("div", {
													className: "flex items-center gap-1.5 text-[var(--avp-brand)] font-semibold",
													children: [/* @__PURE__ */ _jsxDEV("span", {
														className: "text-[var(--avp-text-muted)] font-normal",
														children: formatRelativeModifiedTime(item.updatedAtMs, locale)
													}, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 802,
														columnNumber: 27
													}, this), /* @__PURE__ */ _jsxDEV(Play, { className: "w-3 h-3 fill-current ms-1 opacity-0 group-hover:opacity-100 transition-opacity" }, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 805,
														columnNumber: 27
													}, this)]
												}, void 0, true, {
													fileName: _jsxFileName,
													lineNumber: 801,
													columnNumber: 25
												}, this)]
											}, void 0, true, {
												fileName: _jsxFileName,
												lineNumber: 781,
												columnNumber: 23
											}, this)
										]
									}, item.id, true, {
										fileName: _jsxFileName,
										lineNumber: 612,
										columnNumber: 21
									}, this);
								})
							},
							void 0,
							false,
							{
								fileName: _jsxFileName,
								lineNumber: 596,
								columnNumber: 15
							},
							this
						) : 
						/* High-Density Studio Table View (Blueprint 1 - P2-1) */
						/* @__PURE__ */ _jsxDEV("div", {
							"data-testid": "projects-table",
							className: "rounded-[var(--avp-radius-lg)] border border-[var(--avp-border)] bg-[var(--avp-surface)] overflow-hidden shadow-[var(--avp-shadow-xs)]",
							children: /* @__PURE__ */ _jsxDEV("table", {
								className: "w-full text-xs border-collapse",
								children: [/* @__PURE__ */ _jsxDEV("thead", { children: /* @__PURE__ */ _jsxDEV("tr", {
									className: "h-9 border-b border-[var(--avp-border)] bg-[var(--avp-surface-2)] text-[11px] text-[var(--avp-text-secondary)]",
									children: [
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-start font-semibold",
											children: isFa ? "نام پروژه" : "Project Name"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 821,
											columnNumber: 23
										}, this),
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-start font-semibold hidden sm:table-cell",
											children: isFa ? "فایل صوتی" : "Source Audio"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 824,
											columnNumber: 23
										}, this),
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-start font-semibold",
											children: isFa ? "وضعیت" : "Status"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 827,
											columnNumber: 23
										}, this),
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-start font-semibold",
											children: isFa ? "مدت‌زمان" : "Duration"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 830,
											columnNumber: 23
										}, this),
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-start font-semibold hidden md:table-cell",
											children: isFa ? "تعداد کلمات" : "Words"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 833,
											columnNumber: 23
										}, this),
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-start font-semibold hidden lg:table-cell",
											children: isFa ? "آخرین ویرایش" : "Modified"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 836,
											columnNumber: 23
										}, this),
										/* @__PURE__ */ _jsxDEV("th", {
											className: "px-3 text-end font-semibold",
											children: isFa ? "عملیات" : "Actions"
										}, void 0, false, {
											fileName: _jsxFileName,
											lineNumber: 839,
											columnNumber: 23
										}, this)
									]
								}, void 0, true, {
									fileName: _jsxFileName,
									lineNumber: 820,
									columnNumber: 21
								}, this) }, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 819,
									columnNumber: 19
								}, this), /* @__PURE__ */ _jsxDEV("tbody", {
									className: "divide-y divide-[var(--avp-border-subtle)]",
									children: filteredProjects.map((item) => {
										const isPlayingPreview = previewPlayingId === item.id;
										return /* @__PURE__ */ _jsxDEV("tr", {
											"data-testid": `project-card-${item.id}`,
											onClick: () => onOpenProject(item.id),
											className: "h-12 hover:bg-[var(--avp-hover)] transition-colors cursor-pointer",
											children: [
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3 font-bold text-[var(--avp-text)]",
													children: /* @__PURE__ */ _jsxDEV("div", {
														className: "flex items-center gap-2",
														children: [/* @__PURE__ */ _jsxDEV("button", {
															type: "button",
															onClick: (e) => handleToggleQuickPreview(e, item),
															className: "w-6 h-6 rounded-[var(--avp-radius-xs)] bg-[var(--avp-surface-2)] border border-[var(--avp-border)] flex items-center justify-center text-[var(--avp-brand)] hover:bg-[var(--avp-brand-soft)] cursor-pointer",
															title: isFa ? "پیش‌شنود سریع" : "Quick Audition",
															children: isPlayingPreview ? /* @__PURE__ */ _jsxDEV(Square, { className: "w-2.5 h-2.5 fill-current" }, void 0, false, {
																fileName: _jsxFileName,
																lineNumber: 863,
																columnNumber: 35
															}, this) : /* @__PURE__ */ _jsxDEV(Play, { className: "w-2.5 h-2.5 fill-current" }, void 0, false, {
																fileName: _jsxFileName,
																lineNumber: 865,
																columnNumber: 35
															}, this)
														}, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 856,
															columnNumber: 31
														}, this), /* @__PURE__ */ _jsxDEV("span", {
															className: "truncate max-w-[240px]",
															children: item.name
														}, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 868,
															columnNumber: 31
														}, this)]
													}, void 0, true, {
														fileName: _jsxFileName,
														lineNumber: 855,
														columnNumber: 29
													}, this)
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 854,
													columnNumber: 27
												}, this),
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3 text-[var(--avp-text-secondary)] font-mono text-[11px] hidden sm:table-cell",
													dir: "ltr",
													children: item.sourceFileName
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 871,
													columnNumber: 27
												}, this),
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3",
													children: /* @__PURE__ */ _jsxDEV("span", {
														className: `inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${getStatusBadgeClasses(item.status)}`,
														children: formatProjectStatusLabel(item.status, locale)
													}, void 0, false, {
														fileName: _jsxFileName,
														lineNumber: 878,
														columnNumber: 29
													}, this)
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 877,
													columnNumber: 27
												}, this),
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3 font-mono font-semibold",
													dir: "ltr",
													children: formatAudioDurationClock(item.durationSec)
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 886,
													columnNumber: 27
												}, this),
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3 text-[var(--avp-text-secondary)] hidden md:table-cell",
													children: item.wordCount
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 889,
													columnNumber: 27
												}, this),
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3 text-[var(--avp-text-muted)] hidden lg:table-cell",
													children: formatRelativeModifiedTime(item.updatedAtMs, locale)
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 892,
													columnNumber: 27
												}, this),
												/* @__PURE__ */ _jsxDEV("td", {
													className: "px-3 text-end",
													onClick: (e) => e.stopPropagation(),
													children: /* @__PURE__ */ _jsxDEV("div", {
														className: "inline-flex items-center gap-1.5",
														children: [/* @__PURE__ */ _jsxDEV("button", {
															type: "button",
															onClick: () => onOpenProject(item.id),
															className: "h-7 px-2.5 rounded-[var(--avp-radius-sm)] bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] text-[11px] font-semibold cursor-pointer",
															children: isFa ? "ورود به استودیو" : "Open"
														}, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 900,
															columnNumber: 31
														}, this), /* @__PURE__ */ _jsxDEV("button", {
															type: "button",
															"data-testid": `project-menu-btn-${item.id}`,
															onClick: () => setConfirmDeleteItem(item),
															className: "w-7 h-7 rounded-[var(--avp-radius-sm)] text-[var(--avp-text-secondary)] hover:text-[var(--avp-error)] hover:bg-[var(--avp-error)]/10 inline-flex items-center justify-center cursor-pointer",
															children: /* @__PURE__ */ _jsxDEV(Trash2, { className: "w-3.5 h-3.5" }, void 0, false, {
																fileName: _jsxFileName,
																lineNumber: 913,
																columnNumber: 33
															}, this)
														}, void 0, false, {
															fileName: _jsxFileName,
															lineNumber: 907,
															columnNumber: 31
														}, this)]
													}, void 0, true, {
														fileName: _jsxFileName,
														lineNumber: 899,
														columnNumber: 29
													}, this)
												}, void 0, false, {
													fileName: _jsxFileName,
													lineNumber: 895,
													columnNumber: 27
												}, this)
											]
										}, item.id, true, {
											fileName: _jsxFileName,
											lineNumber: 848,
											columnNumber: 25
										}, this);
									})
								}, void 0, false, {
									fileName: _jsxFileName,
									lineNumber: 844,
									columnNumber: 19
								}, this)]
							}, void 0, true, {
								fileName: _jsxFileName,
								lineNumber: 818,
								columnNumber: 17
							}, this)
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 814,
							columnNumber: 15
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 484,
						columnNumber: 11
					}, this)
				]
			}, void 0, true, {
				fileName: _jsxFileName,
				lineNumber: 327,
				columnNumber: 7
			}, this),
			confirmDeleteItem && /* @__PURE__ */ _jsxDEV("div", {
				className: "fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4",
				role: "dialog",
				"aria-modal": "true",
				"data-testid": "confirm-delete-project-modal",
				onClick: () => setConfirmDeleteItem(null),
				children: /* @__PURE__ */ _jsxDEV("div", {
					className: "w-full max-w-md rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] p-5 shadow-[var(--avp-shadow-md)] space-y-4",
					onClick: (e) => e.stopPropagation(),
					children: [/* @__PURE__ */ _jsxDEV("div", {
						className: "flex items-start gap-3",
						children: [/* @__PURE__ */ _jsxDEV("div", {
							className: "w-10 h-10 rounded-xl bg-[var(--avp-error)]/15 text-[var(--avp-error)] flex items-center justify-center shrink-0",
							children: /* @__PURE__ */ _jsxDEV(Trash2, { className: "w-5 h-5" }, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 943,
								columnNumber: 17
							}, this)
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 942,
							columnNumber: 15
						}, this), /* @__PURE__ */ _jsxDEV("div", {
							className: "space-y-1",
							children: [/* @__PURE__ */ _jsxDEV("h3", {
								className: "text-base font-bold text-[var(--avp-text)]",
								children: isFa ? "حذف پروژه؟" : "Delete Project?"
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 946,
								columnNumber: 17
							}, this), /* @__PURE__ */ _jsxDEV("p", {
								className: "text-xs text-[var(--avp-text-secondary)] leading-relaxed",
								children: isFa ? `آیا از حذف پروژه «${confirmDeleteItem.name}» مطمئن هستید؟ این عمل قابل بازگشت نیست.` : `Are you sure you want to delete "${confirmDeleteItem.name}"? This action cannot be undone.`
							}, void 0, false, {
								fileName: _jsxFileName,
								lineNumber: 949,
								columnNumber: 17
							}, this)]
						}, void 0, true, {
							fileName: _jsxFileName,
							lineNumber: 945,
							columnNumber: 15
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 941,
						columnNumber: 13
					}, this), /* @__PURE__ */ _jsxDEV("div", {
						className: "flex items-center justify-end gap-2 pt-2",
						children: [/* @__PURE__ */ _jsxDEV("button", {
							type: "button",
							onClick: () => setConfirmDeleteItem(null),
							disabled: isDeleting,
							className: "h-9 px-4 rounded-xl border border-[var(--avp-border)] text-xs font-medium text-[var(--avp-text-secondary)] hover:bg-[var(--avp-hover)] cursor-pointer",
							children: isFa ? "انصراف" : "Cancel"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 958,
							columnNumber: 15
						}, this), /* @__PURE__ */ _jsxDEV("button", {
							type: "button",
							"data-testid": "btn-confirm-delete-project",
							onClick: () => void handleConfirmDelete(),
							disabled: isDeleting,
							className: "h-9 px-4 rounded-xl bg-[var(--avp-error)] text-white text-xs font-semibold hover:opacity-90 cursor-pointer",
							children: isDeleting ? isFa ? "در حال حذف..." : "Deleting..." : isFa ? "حذف پروژه" : "Delete Project"
						}, void 0, false, {
							fileName: _jsxFileName,
							lineNumber: 966,
							columnNumber: 15
						}, this)]
					}, void 0, true, {
						fileName: _jsxFileName,
						lineNumber: 957,
						columnNumber: 13
					}, this)]
				}, void 0, true, {
					fileName: _jsxFileName,
					lineNumber: 937,
					columnNumber: 11
				}, this)
			}, void 0, false, {
				fileName: _jsxFileName,
				lineNumber: 930,
				columnNumber: 9
			}, this)
		]
	}, void 0, true, {
		fileName: _jsxFileName,
		lineNumber: 225,
		columnNumber: 5
	}, this);
};

//# sourceMappingURL=data:application/json;base64,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LGNBQ0E7TUFDQTs7OztjQUNMOzs7OzthQUNGOzs7Ozs7R0FDRjs7Ozs7RUFFSjs7Ozs7O0FBRVQiLCJuYW1lcyI6W10sInNvdXJjZXMiOlsiUHJvamVjdHNIdWJWaWV3LnRzeCJdLCJ2ZXJzaW9uIjozLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QsIHsgdXNlTWVtbywgdXNlUmVmLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0JztcbmltcG9ydCB7XG4gIEFsZXJ0Q2lyY2xlLFxuICBDaGVja0NpcmNsZTIsXG4gIENsb2NrLFxuICBDb3B5LFxuICBFZGl0MyxcbiAgRmlsZUF1ZGlvLFxuICBGb2xkZXJPcGVuLFxuICBMYW5ndWFnZXMsXG4gIExheW91dEdyaWQsXG4gIExpc3QsXG4gIExvYWRlcjIsXG4gIE1vb24sXG4gIE1vcmVWZXJ0aWNhbCxcbiAgUGxheSxcbiAgUGx1cyxcbiAgUmVmcmVzaEN3LFxuICBTZWFyY2gsXG4gIFNldHRpbmdzLFxuICBTaGllbGRDaGVjayxcbiAgU3BhcmtsZXMsXG4gIFNxdWFyZSxcbiAgU3VuLFxuICBUcmFzaDIsXG4gIFdhbmQyLFxufSBmcm9tICdsdWNpZGUtcmVhY3QnO1xuaW1wb3J0IHtcbiAgUGVyc2lzdGVkUHJvamVjdFN1bW1hcnksXG4gIFByb2plY3RGaWx0ZXJUYWIsXG4gIFByb2plY3RMaWZlY3ljbGVTdGF0dXMsXG4gIFByb2plY3RTb3J0RmllbGQsXG4gIGZpbHRlckFuZFNvcnRQcm9qZWN0cyxcbn0gZnJvbSAnLi4vcHJvamVjdHMvcHJvamVjdExpYnJhcnlMb2dpYyc7XG5cbmludGVyZmFjZSBQcm9qZWN0c0h1YlZpZXdQcm9wcyB7XG4gIGxvY2FsZTogJ2ZhJyB8ICdlbic7XG4gIHRoZW1lOiAnbGlnaHQnIHwgJ2RhcmsnO1xuICBwcm9qZWN0czogUGVyc2lzdGVkUHJvamVjdFN1bW1hcnlbXTtcbiAgaXNMb2FkaW5nOiBib29sZWFuO1xuICBlcnJvck1lc3NhZ2U6IHN0cmluZyB8IG51bGw7XG4gIGNvcnJ1cHRlZENvdW50OiBudW1iZXI7XG4gIG9uUmV0cnlMb2FkOiAoKSA9PiB2b2lkO1xuICBvbk9wZW5OZXdQcm9qZWN0TW9kYWw6ICgpID0+IHZvaWQ7XG4gIG9uT3BlblByb2plY3Q6IChwcm9qZWN0SWQ6IHN0cmluZykgPT4gdm9pZDtcbiAgb25PcGVuU2FtcGxlU3R1ZGlvOiAoKSA9PiB2b2lkO1xuICBvblJlbmFtZVByb2plY3Q6IChwcm9qZWN0SWQ6IHN0cmluZywgbmV3VGl0bGU6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcbiAgb25EdXBsaWNhdGVQcm9qZWN0OiAocHJvamVjdElkOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG4gIG9uRGVsZXRlUHJvamVjdDogKHByb2plY3RJZDogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+O1xuICBvblRvZ2dsZVRoZW1lOiAoKSA9PiB2b2lkO1xuICBvblRvZ2dsZUxvY2FsZTogKCkgPT4gdm9pZDtcbiAgb25PcGVuU2V0dGluZ3M6ICgpID0+IHZvaWQ7XG4gIG9uT3BlbkxpZmVjeWNsZU1vZGFsPzogKCkgPT4gdm9pZDtcbn1cblxudHlwZSBIdWJWaWV3TW9kZSA9ICdncmlkJyB8ICd0YWJsZSc7XG5cbmZ1bmN0aW9uIGZvcm1hdEF1ZGlvRHVyYXRpb25DbG9jayhzZWM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHNhZmUgPSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKHNlYyB8fCAwKSk7XG4gIGNvbnN0IG1pbnMgPSBNYXRoLmZsb29yKHNhZmUgLyA2MCk7XG4gIGNvbnN0IHNlY3MgPSBzYWZlICUgNjA7XG4gIHJldHVybiBgJHtTdHJpbmcobWlucykucGFkU3RhcnQoMiwgJzAnKX06JHtTdHJpbmcoc2VjcykucGFkU3RhcnQoMiwgJzAnKX1gO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRSZWxhdGl2ZU1vZGlmaWVkVGltZSh1cGRhdGVkQXRNczogbnVtYmVyLCBsb2NhbGU6ICdmYScgfCAnZW4nKTogc3RyaW5nIHtcbiAgY29uc3QgZGlmZlNlYyA9IE1hdGgubWF4KDAsIE1hdGguZmxvb3IoKERhdGUubm93KCkgLSB1cGRhdGVkQXRNcykgLyAxMDAwKSk7XG4gIGlmIChkaWZmU2VjIDwgNjApIHJldHVybiBsb2NhbGUgPT09ICdmYScgPyAn2obZhtivINmE2K3YuNmHINm+24zYtCcgOiAnSnVzdCBub3cnO1xuICBjb25zdCBkaWZmTWluID0gTWF0aC5mbG9vcihkaWZmU2VjIC8gNjApO1xuICBpZiAoZGlmZk1pbiA8IDYwKSByZXR1cm4gbG9jYWxlID09PSAnZmEnID8gYCR7ZGlmZk1pbn0g2K/ZgtuM2YLZhyDZvtuM2LRgIDogYCR7ZGlmZk1pbn1tIGFnb2A7XG4gIGNvbnN0IGRpZmZIciA9IE1hdGguZmxvb3IoZGlmZk1pbiAvIDYwKTtcbiAgaWYgKGRpZmZIciA8IDI0KSByZXR1cm4gbG9jYWxlID09PSAnZmEnID8gYCR7ZGlmZkhyfSDYs9in2LnYqiDZvtuM2LRgIDogYCR7ZGlmZkhyfWggYWdvYDtcbiAgY29uc3QgZGlmZkRheSA9IE1hdGguZmxvb3IoZGlmZkhyIC8gMjQpO1xuICByZXR1cm4gbG9jYWxlID09PSAnZmEnID8gYCR7ZGlmZkRheX0g2LHZiNiyINm+24zYtGAgOiBgJHtkaWZmRGF5fWQgYWdvYDtcbn1cblxuZnVuY3Rpb24gZm9ybWF0UHJvamVjdFN0YXR1c0xhYmVsKHN0YXR1czogUHJvamVjdExpZmVjeWNsZVN0YXR1cywgbG9jYWxlOiAnZmEnIHwgJ2VuJyk6IHN0cmluZyB7XG4gIHN3aXRjaCAoc3RhdHVzKSB7XG4gICAgY2FzZSAnY29tcGxldGVkJzpcbiAgICAgIHJldHVybiBsb2NhbGUgPT09ICdmYScgPyAn2KraqdmF24zZhOKAjNi02K/ZhycgOiAnQ29tcGxldGVkJztcbiAgICBjYXNlICdyZXZpZXcnOlxuICAgICAgcmV0dXJuIGxvY2FsZSA9PT0gJ2ZhJyA/ICfYotmF2KfYr9mHINio2KfYstio24zZhtuMJyA6ICdJbiBSZXZpZXcnO1xuICAgIGNhc2UgJ2VkaXRpbmcnOlxuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gbG9jYWxlID09PSAnZmEnID8gJ9iv2LEg2K3Yp9mEINiq2K/ZiNuM2YYnIDogJ0VkaXRpbmcnO1xuICB9XG59XG5cbmZ1bmN0aW9uIGdldFN0YXR1c0JhZGdlQ2xhc3NlcyhzdGF0dXM6IFByb2plY3RMaWZlY3ljbGVTdGF0dXMpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgJ3Jldmlldyc6XG4gICAgICByZXR1cm4gJ2JnLVt2YXIoLS1hdnAtYnJhbmQtc29mdCldIHRleHQtW3ZhcigtLWF2cC1icmFuZCldIGJvcmRlci1bdmFyKC0tYXZwLWJyYW5kKV0vMjUnO1xuICAgIGNhc2UgJ2NvbXBsZXRlZCc6XG4gICAgICByZXR1cm4gJ2JnLVt2YXIoLS1hdnAtc3VjY2VzcyldLzE1IHRleHQtW3ZhcigtLWF2cC1zdWNjZXNzKV0gYm9yZGVyLVt2YXIoLS1hdnAtc3VjY2VzcyldLzMwJztcbiAgICBjYXNlICdlZGl0aW5nJzpcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuICdiZy1bdmFyKC0tYXZwLXN1cmZhY2UtMildIHRleHQtW3ZhcigtLWF2cC10ZXh0LXNlY29uZGFyeSldIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildJztcbiAgfVxufVxuXG5leHBvcnQgY29uc3QgUHJvamVjdHNIdWJWaWV3OiBSZWFjdC5GQzxQcm9qZWN0c0h1YlZpZXdQcm9wcz4gPSAoe1xuICBsb2NhbGUsXG4gIHRoZW1lLFxuICBwcm9qZWN0cyxcbiAgaXNMb2FkaW5nLFxuICBlcnJvck1lc3NhZ2UsXG4gIGNvcnJ1cHRlZENvdW50LFxuICBvblJldHJ5TG9hZCxcbiAgb25PcGVuTmV3UHJvamVjdE1vZGFsLFxuICBvbk9wZW5Qcm9qZWN0LFxuICBvbk9wZW5TYW1wbGVTdHVkaW8sXG4gIG9uUmVuYW1lUHJvamVjdCxcbiAgb25EdXBsaWNhdGVQcm9qZWN0LFxuICBvbkRlbGV0ZVByb2plY3QsXG4gIG9uVG9nZ2xlVGhlbWUsXG4gIG9uVG9nZ2xlTG9jYWxlLFxuICBvbk9wZW5TZXR0aW5ncyxcbiAgb25PcGVuTGlmZWN5Y2xlTW9kYWwsXG59KSA9PiB7XG4gIGNvbnN0IGlzRmEgPSBsb2NhbGUgPT09ICdmYSc7XG4gIGNvbnN0IFtzZWFyY2hRdWVyeSwgc2V0U2VhcmNoUXVlcnldID0gdXNlU3RhdGUoJycpO1xuICBjb25zdCBbc3RhdHVzRmlsdGVyLCBzZXRTdGF0dXNGaWx0ZXJdID0gdXNlU3RhdGU8UHJvamVjdEZpbHRlclRhYj4oJ2FsbCcpO1xuICBjb25zdCBbc29ydEJ5LCBzZXRTb3J0QnldID0gdXNlU3RhdGU8UHJvamVjdFNvcnRGaWVsZD4oJ3VwZGF0ZWRBdCcpO1xuICBjb25zdCBbdmlld01vZGUsIHNldFZpZXdNb2RlXSA9IHVzZVN0YXRlPEh1YlZpZXdNb2RlPignZ3JpZCcpO1xuICBjb25zdCBbb3Blbk1lbnVJZCwgc2V0T3Blbk1lbnVJZF0gPSB1c2VTdGF0ZTxzdHJpbmcgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW3JlbmFtaW5nSWQsIHNldFJlbmFtaW5nSWRdID0gdXNlU3RhdGU8c3RyaW5nIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IFtyZW5hbWVEcmFmdCwgc2V0UmVuYW1lRHJhZnRdID0gdXNlU3RhdGUoJycpO1xuICBjb25zdCBbY29uZmlybURlbGV0ZUl0ZW0sIHNldENvbmZpcm1EZWxldGVJdGVtXSA9IHVzZVN0YXRlPFBlcnNpc3RlZFByb2plY3RTdW1tYXJ5IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IFtpc0RlbGV0aW5nLCBzZXRJc0RlbGV0aW5nXSA9IHVzZVN0YXRlKGZhbHNlKTtcbiAgY29uc3QgW3ByZXZpZXdQbGF5aW5nSWQsIHNldFByZXZpZXdQbGF5aW5nSWRdID0gdXNlU3RhdGU8c3RyaW5nIHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IHByZXZpZXdUaW1lclJlZiA9IHVzZVJlZjxudW1iZXIgfCBudWxsPihudWxsKTtcbiAgY29uc3QgcHJldmlld0F1ZGlvQ3R4UmVmID0gdXNlUmVmPEF1ZGlvQ29udGV4dCB8IG51bGw+KG51bGwpO1xuXG4gIGNvbnN0IHN0b3BQcmV2aWV3QXVkaW8gPSAoKSA9PiB7XG4gICAgaWYgKHByZXZpZXdUaW1lclJlZi5jdXJyZW50KSB7XG4gICAgICB3aW5kb3cuY2xlYXJUaW1lb3V0KHByZXZpZXdUaW1lclJlZi5jdXJyZW50KTtcbiAgICAgIHByZXZpZXdUaW1lclJlZi5jdXJyZW50ID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKHByZXZpZXdBdWRpb0N0eFJlZi5jdXJyZW50KSB7XG4gICAgICBwcmV2aWV3QXVkaW9DdHhSZWYuY3VycmVudC5jbG9zZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIHByZXZpZXdBdWRpb0N0eFJlZi5jdXJyZW50ID0gbnVsbDtcbiAgICB9XG4gICAgc2V0UHJldmlld1BsYXlpbmdJZChudWxsKTtcbiAgfTtcblxuICBjb25zdCBoYW5kbGVUb2dnbGVRdWlja1ByZXZpZXcgPSAoZTogUmVhY3QuTW91c2VFdmVudCwgaXRlbTogUGVyc2lzdGVkUHJvamVjdFN1bW1hcnkpID0+IHtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGlmIChwcmV2aWV3UGxheWluZ0lkID09PSBpdGVtLmlkKSB7XG4gICAgICBzdG9wUHJldmlld0F1ZGlvKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN0b3BQcmV2aWV3QXVkaW8oKTtcbiAgICBzZXRQcmV2aWV3UGxheWluZ0lkKGl0ZW0uaWQpO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IEF1ZGlvQ3R4ID1cbiAgICAgICAgd2luZG93LkF1ZGlvQ29udGV4dCB8fFxuICAgICAgICAod2luZG93IGFzIHVua25vd24gYXMgeyB3ZWJraXRBdWRpb0NvbnRleHQ6IHR5cGVvZiBBdWRpb0NvbnRleHQgfSkud2Via2l0QXVkaW9Db250ZXh0O1xuICAgICAgaWYgKEF1ZGlvQ3R4KSB7XG4gICAgICAgIGNvbnN0IGN0eCA9IG5ldyBBdWRpb0N0eCgpO1xuICAgICAgICBwcmV2aWV3QXVkaW9DdHhSZWYuY3VycmVudCA9IGN0eDtcbiAgICAgICAgY29uc3Qgb3NjID0gY3R4LmNyZWF0ZU9zY2lsbGF0b3IoKTtcbiAgICAgICAgY29uc3QgZ2FpbiA9IGN0eC5jcmVhdGVHYWluKCk7XG4gICAgICAgIG9zYy50eXBlID0gJ3NpbmUnO1xuICAgICAgICBvc2MuZnJlcXVlbmN5LnNldFZhbHVlQXRUaW1lKDE5NiwgY3R4LmN1cnJlbnRUaW1lKTtcbiAgICAgICAgY29uc3QgcGVha3M6IHJlYWRvbmx5IG51bWJlcltdID0gaXRlbS53YXZlZm9ybVByZXZpZXdQZWFrcz8ubGVuZ3RoXG4gICAgICAgICAgPyBpdGVtLndhdmVmb3JtUHJldmlld1BlYWtzXG4gICAgICAgICAgOiBbMC4zNSwgMC43LCAwLjQ1LCAwLjg1LCAwLjVdO1xuICAgICAgICBnYWluLmdhaW4uc2V0VmFsdWVBdFRpbWUoMC4wMDEsIGN0eC5jdXJyZW50VGltZSk7XG4gICAgICAgIHBlYWtzLnNsaWNlKDAsIDEyKS5mb3JFYWNoKChwOiBudW1iZXIsIGlkeDogbnVtYmVyKSA9PiB7XG4gICAgICAgICAgY29uc3QgdCA9IGN0eC5jdXJyZW50VGltZSArIGlkeCAqIDAuMTQ7XG4gICAgICAgICAgZ2Fpbi5nYWluLmV4cG9uZW50aWFsUmFtcFRvVmFsdWVBdFRpbWUoXG4gICAgICAgICAgICBNYXRoLm1heCgwLjAwNCwgTWF0aC5taW4oMC4wNiwgcCAqIDAuMDYpKSxcbiAgICAgICAgICAgIHQsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBvc2MuZnJlcXVlbmN5LnNldFZhbHVlQXRUaW1lKDE3NSArIE1hdGgucm91bmQocCAqIDExMCksIHQpO1xuICAgICAgICB9KTtcbiAgICAgICAgZ2Fpbi5nYWluLmV4cG9uZW50aWFsUmFtcFRvVmFsdWVBdFRpbWUoMC4wMDAxLCBjdHguY3VycmVudFRpbWUgKyAxLjc1KTtcbiAgICAgICAgb3NjLmNvbm5lY3QoZ2Fpbik7XG4gICAgICAgIGdhaW4uY29ubmVjdChjdHguZGVzdGluYXRpb24pO1xuICAgICAgICBvc2Muc3RhcnQoKTtcbiAgICAgICAgb3NjLnN0b3AoY3R4LmN1cnJlbnRUaW1lICsgMS44KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEF1ZGlvQ29udGV4dCBtYXkgYmUgYmxvY2tlZCBpbiBoZWFkbGVzcyBvciByZXN0cmljdGVkIGNvbnRleHQ7IHZpc3VhbCBwcmV2aWV3IHN0aWxsIHJ1bnNcbiAgICB9XG5cbiAgICBwcmV2aWV3VGltZXJSZWYuY3VycmVudCA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHN0b3BQcmV2aWV3QXVkaW8oKTtcbiAgICB9LCAxODAwKTtcbiAgfTtcblxuICBjb25zdCBmaWx0ZXJlZFByb2plY3RzID0gdXNlTWVtbygoKSA9PiB7XG4gICAgcmV0dXJuIGZpbHRlckFuZFNvcnRQcm9qZWN0cyhwcm9qZWN0cywge1xuICAgICAgcXVlcnk6IHNlYXJjaFF1ZXJ5LFxuICAgICAgZmlsdGVyOiBzdGF0dXNGaWx0ZXIsXG4gICAgICBzb3J0QnksXG4gICAgfSk7XG4gIH0sIFtwcm9qZWN0cywgc2VhcmNoUXVlcnksIHN0YXR1c0ZpbHRlciwgc29ydEJ5XSk7XG5cbiAgY29uc3QgaGFuZGxlU3RhcnRSZW5hbWUgPSAoaXRlbTogUGVyc2lzdGVkUHJvamVjdFN1bW1hcnkpID0+IHtcbiAgICBzZXRPcGVuTWVudUlkKG51bGwpO1xuICAgIHNldFJlbmFtaW5nSWQoaXRlbS5pZCk7XG4gICAgc2V0UmVuYW1lRHJhZnQoaXRlbS5uYW1lKTtcbiAgfTtcblxuICBjb25zdCBoYW5kbGVDb21taXRSZW5hbWUgPSBhc3luYyAocHJvamVjdElkOiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBjbGVhbiA9IHJlbmFtZURyYWZ0LnRyaW0oKTtcbiAgICBzZXRSZW5hbWluZ0lkKG51bGwpO1xuICAgIGlmICghY2xlYW4pIHJldHVybjtcbiAgICBhd2FpdCBvblJlbmFtZVByb2plY3QocHJvamVjdElkLCBjbGVhbik7XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ29uZmlybURlbGV0ZSA9IGFzeW5jICgpID0+IHtcbiAgICBpZiAoIWNvbmZpcm1EZWxldGVJdGVtKSByZXR1cm47XG4gICAgc2V0SXNEZWxldGluZyh0cnVlKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgb25EZWxldGVQcm9qZWN0KGNvbmZpcm1EZWxldGVJdGVtLmlkKTtcbiAgICAgIHNldENvbmZpcm1EZWxldGVJdGVtKG51bGwpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBzZXRJc0RlbGV0aW5nKGZhbHNlKTtcbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2XG4gICAgICBkaXI9e2lzRmEgPyAncnRsJyA6ICdsdHInfVxuICAgICAgY2xhc3NOYW1lPVwibWluLWgtc2NyZWVuIGZsZXggZmxleC1jb2wgYmctW3ZhcigtLWF2cC1iZyldIHRleHQtW3ZhcigtLWF2cC10ZXh0KV1cIlxuICAgICAgb25DbGljaz17KCkgPT4gc2V0T3Blbk1lbnVJZChudWxsKX1cbiAgICA+XG4gICAgICB7LyogVW5pZmllZCA0OHB4IEdsb2JhbCBBcHBsaWNhdGlvbiBIZWFkZXIgKFNoYXJlZCBBcmNoaXRlY3R1cmUgd2l0aCBIZWFkZXJOYXYpICovfVxuICAgICAgPGhlYWRlciBjbGFzc05hbWU9XCJzdGlja3kgdG9wLTAgei0zMCBoLVt2YXIoLS1hdnAtaGVhZGVyLWgpXSBiZy1bdmFyKC0tYXZwLXN1cmZhY2UpXSBib3JkZXItYiBib3JkZXItW3ZhcigtLWF2cC1ib3JkZXIpXSBweC0zIHNtOnB4LTUgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zXCI+XG4gICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIuNSBtaW4tdy0wXCI+XG4gICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJ3LTcgaC03IHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMtc20pXSBiZy1bdmFyKC0tYXZwLWJyYW5kKV0gdGV4dC13aGl0ZSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBzaGFkb3ctW3ZhcigtLWF2cC1zaGFkb3cteHMpXSBzaHJpbmstMFwiPlxuICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PVwiMCAwIDI0IDI0XCIgY2xhc3NOYW1lPVwidy00IGgtNFwiIGZpbGw9XCJub25lXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+XG4gICAgICAgICAgICAgIDxwYXRoXG4gICAgICAgICAgICAgICAgZD1cIk00IDEyLjVoMi4ybDEuOC01LjUgMi42IDEwIDIuNC03LjUgMS44IDQuMiAxLjctMS4ySDIwXCJcbiAgICAgICAgICAgICAgICBzdHJva2U9XCJjdXJyZW50Q29sb3JcIlxuICAgICAgICAgICAgICAgIHN0cm9rZVdpZHRoPVwiMi4xXCJcbiAgICAgICAgICAgICAgICBzdHJva2VMaW5lY2FwPVwicm91bmRcIlxuICAgICAgICAgICAgICAgIHN0cm9rZUxpbmVqb2luPVwicm91bmRcIlxuICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgPC9zdmc+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiBtaW4tdy0wXCI+XG4gICAgICAgICAgICA8aDEgY2xhc3NOYW1lPVwidGV4dC1bMTNweF0gZm9udC1ib2xkIHRyYWNraW5nLXRpZ2h0IHRleHQtW3ZhcigtLWF2cC10ZXh0KV0gbGVhZGluZy1ub25lXCI+XG4gICAgICAgICAgICAgIHtpc0ZhID8gJ9ii2YjYp9m+2LHYr9in2LInIDogJ0F2YXBhcmRheid9XG4gICAgICAgICAgICA8L2gxPlxuICAgICAgICAgICAgPHNwYW4gY2xhc3NOYW1lPVwiaGlkZGVuIHNtOmlubGluZS1ibG9jayB0ZXh0LVsxMXB4XSBweC0yIHB5LTAuNSByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLXhzKV0gYmctW3ZhcigtLWF2cC1zdXJmYWNlLTIpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyLXN1YnRsZSldIGZvbnQtbWVkaXVtXCI+XG4gICAgICAgICAgICAgIHtpc0ZhID8gJ9in2LPYqtmI2K/bjNmI24wg2KrYr9mI24zZhiDar9mB2KrYp9ixINmIINm+2KfYr9qp2LPYqicgOiAnUGVyc2lhbiBTcGVlY2ggJiBQb2RjYXN0IFN0dWRpbyd9XG4gICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIj5cbiAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgIGRhdGEtdGVzdGlkPVwiYnRuLW5ldy1wcm9qZWN0XCJcbiAgICAgICAgICAgIG9uQ2xpY2s9e29uT3Blbk5ld1Byb2plY3RNb2RhbH1cbiAgICAgICAgICAgIGNsYXNzTmFtZT1cImF2cC1idG4tcHJpbWFyeSB0ZXh0LXhzIGZvbnQtc2VtaWJvbGQgY3Vyc29yLXBvaW50ZXIgc2hhZG93LVt2YXIoLS1hdnAtc2hhZG93LXhzKV1cIlxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxQbHVzIGNsYXNzTmFtZT1cInctMy41IGgtMy41XCIgLz5cbiAgICAgICAgICAgIDxzcGFuPntpc0ZhID8gJ9m+2LHZiNqY2Ycg2KzYr9uM2K8nIDogJ05ldyBQcm9qZWN0J308L3NwYW4+XG4gICAgICAgICAgPC9idXR0b24+XG5cbiAgICAgICAgICB7LyogVW5pZmllZCA0LUJ1dHRvbiBTeXN0ZW0gVXRpbGl0eSBDYXBzdWxlOiBbRU4vRkEgfCBUaGVtZSB8IFN5c3RlbSBIZWFsdGggfCBTZXR0aW5nc10gKi99XG4gICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IHAtMC41IHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMtc20pXSBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyKV0gYmctW3ZhcigtLWF2cC1zdXJmYWNlLTIpXVwiPlxuICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgb25DbGljaz17b25Ub2dnbGVMb2NhbGV9XG4gICAgICAgICAgICAgIHRpdGxlPXtpc0ZhID8gJ1N3aXRjaCB0byBFbmdsaXNoJyA6ICfYqti624zbjNixINio2Ycg2YHYp9ix2LPbjCd9XG4gICAgICAgICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2KrYutuM24zYsSDYstio2KfZhiDYqNmHINin2Ybar9mE24zYs9uMJyA6ICdTd2l0Y2ggbGFuZ3VhZ2UgdG8gUGVyc2lhbid9XG4gICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtNiBweC0xLjUgcm91bmRlZC1bdmFyKC0tYXZwLXJhZGl1cy14cyldIHRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gaG92ZXI6YmctW3ZhcigtLWF2cC1ob3ZlcildIGhvdmVyOnRleHQtW3ZhcigtLWF2cC10ZXh0KV0gaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGdhcC0xIGN1cnNvci1wb2ludGVyIHRyYW5zaXRpb24tY29sb3JzXCJcbiAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgPExhbmd1YWdlcyBjbGFzc05hbWU9XCJ3LTMgaC0zXCIgLz5cbiAgICAgICAgICAgICAgPHNwYW4+e2lzRmEgPyAnRU4nIDogJ0ZBJ308L3NwYW4+XG4gICAgICAgICAgICA8L2J1dHRvbj5cblxuICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgb25DbGljaz17b25Ub2dnbGVUaGVtZX1cbiAgICAgICAgICAgICAgdGl0bGU9e1xuICAgICAgICAgICAgICAgIHRoZW1lID09PSAnZGFyaydcbiAgICAgICAgICAgICAgICAgID8gaXNGYVxuICAgICAgICAgICAgICAgICAgICA/ICfYrdin2YTYqiDYsdmI2LTZhidcbiAgICAgICAgICAgICAgICAgICAgOiAnTGlnaHQgbW9kZSdcbiAgICAgICAgICAgICAgICAgIDogaXNGYVxuICAgICAgICAgICAgICAgICAgICA/ICfYrdin2YTYqiDYqtuM2LHZhydcbiAgICAgICAgICAgICAgICAgICAgOiAnRGFyayBtb2RlJ1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2KrYutuM24zYsSDYqtmFINix2YjYtNmGINmIINiq24zYsdmHJyA6ICdUb2dnbGUgdGhlbWUnfVxuICAgICAgICAgICAgICBjbGFzc05hbWU9XCJ3LTYgaC02IHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMteHMpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBob3ZlcjpiZy1bdmFyKC0tYXZwLWhvdmVyKV0gaG92ZXI6dGV4dC1bdmFyKC0tYXZwLXRleHQpXSBpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgY3Vyc29yLXBvaW50ZXIgdHJhbnNpdGlvbi1jb2xvcnNcIlxuICAgICAgICAgICAgPlxuICAgICAgICAgICAgICB7dGhlbWUgPT09ICdkYXJrJyA/IChcbiAgICAgICAgICAgICAgICA8U3VuIGNsYXNzTmFtZT1cInctMy41IGgtMy41IHRleHQtYW1iZXItNDAwXCIgLz5cbiAgICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgICA8TW9vbiBjbGFzc05hbWU9XCJ3LTMuNSBoLTMuNVwiIC8+XG4gICAgICAgICAgICAgICl9XG4gICAgICAgICAgICA8L2J1dHRvbj5cblxuICAgICAgICAgICAge29uT3BlbkxpZmVjeWNsZU1vZGFsICYmIChcbiAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgIG9uQ2xpY2s9e29uT3BlbkxpZmVjeWNsZU1vZGFsfVxuICAgICAgICAgICAgICAgIHRpdGxlPXtpc0ZhID8gJ9iz2YTYp9mF2Kog2LPbjNiz2KrZhSDZiCDZhdiv2YTigIzZh9in24wg2KLZgdmE2KfbjNmGJyA6ICdTeXN0ZW0gSGVhbHRoICYgTG9jYWwgTW9kZWxzJ31cbiAgICAgICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gJ9iz2YTYp9mF2Kog2LPbjNiz2KrZhSDZiCDZhdiv2YTigIzZh9in24wg2KLZgdmE2KfbjNmGJyA6ICdTeXN0ZW0gSGVhbHRoICYgTG9jYWwgTW9kZWxzJ31cbiAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJ3LTYgaC02IHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMteHMpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBob3ZlcjpiZy1bdmFyKC0tYXZwLWhvdmVyKV0gaG92ZXI6dGV4dC1bdmFyKC0tYXZwLXRleHQpXSBpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgY3Vyc29yLXBvaW50ZXIgdHJhbnNpdGlvbi1jb2xvcnNcIlxuICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgPFNoaWVsZENoZWNrIGNsYXNzTmFtZT1cInctMy41IGgtMy41IHRleHQtW3ZhcigtLWF2cC1icmFuZCldXCIgLz5cbiAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICApfVxuXG4gICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICBkYXRhLXRlc3RpZD1cImJ0bi1vcGVuLXNldHRpbmdzLWh1YlwiXG4gICAgICAgICAgICAgIG9uQ2xpY2s9e29uT3BlblNldHRpbmdzfVxuICAgICAgICAgICAgICB0aXRsZT17aXNGYSA/ICfYqtmG2LjbjNmF2KfYqicgOiAnU2V0dGluZ3MnfVxuICAgICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gJ9iq2YbYuNuM2YXYp9iqJyA6ICdTZXR0aW5ncyd9XG4gICAgICAgICAgICAgIGNsYXNzTmFtZT1cInctNiBoLTYgcm91bmRlZC1bdmFyKC0tYXZwLXJhZGl1cy14cyldIHRleHQtW3ZhcigtLWF2cC10ZXh0LXNlY29uZGFyeSldIGhvdmVyOmJnLVt2YXIoLS1hdnAtaG92ZXIpXSBob3Zlcjp0ZXh0LVt2YXIoLS1hdnAtdGV4dCldIGlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBjdXJzb3ItcG9pbnRlciB0cmFuc2l0aW9uLWNvbG9yc1wiXG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIDxTZXR0aW5ncyBjbGFzc05hbWU9XCJ3LTMuNSBoLTMuNVwiIC8+XG4gICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2hlYWRlcj5cblxuICAgICAgey8qIE1haW4gQ29udGVudCAqL31cbiAgICAgIDxtYWluIGNsYXNzTmFtZT1cImZsZXgtMSBtYXgtdy1bMTI4MHB4XSB3LWZ1bGwgbXgtYXV0byBweC00IHNtOnB4LTYgcHktNiBzbTpweS04IHNwYWNlLXktNlwiPlxuICAgICAgICB7LyogQ29ycnVwdGVkIGl0ZW0gd2FybmluZyAqL31cbiAgICAgICAge2NvcnJ1cHRlZENvdW50ID4gMCAmJiAoXG4gICAgICAgICAgPGRpdlxuICAgICAgICAgICAgcm9sZT1cInN0YXR1c1wiXG4gICAgICAgICAgICBjbGFzc05hbWU9XCJwLTMuNSByb3VuZGVkLXhsIGJvcmRlciBib3JkZXItW3ZhcigtLWF2cC13YXJuaW5nKV0vNDAgYmctW3ZhcigtLWF2cC1hY2NlbnQtc29mdCldLzUwIHRleHQteHMgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zXCJcbiAgICAgICAgICA+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI+XG4gICAgICAgICAgICAgIDxBbGVydENpcmNsZSBjbGFzc05hbWU9XCJ3LTQgaC00IHRleHQtW3ZhcigtLWF2cC13YXJuaW5nKV0gc2hyaW5rLTBcIiAvPlxuICAgICAgICAgICAgICA8c3Bhbj5cbiAgICAgICAgICAgICAgICB7aXNGYVxuICAgICAgICAgICAgICAgICAgPyBgJHtjb3JydXB0ZWRDb3VudH0g2b7YsdmI2pjZhyDZgtiv24zZhduMINuM2Kcg2KLYs9uM2KjigIzYr9uM2K/ZhyDZhtin2K/bjNiv2Ycg2q/YsdmB2KrZhyDYtNivINiq2Kcg2LnZhdmE2qnYsdivINio2LHZhtin2YXZhyDZhdiu2KrZhCDZhti02YjYry5gXG4gICAgICAgICAgICAgICAgICA6IGAke2NvcnJ1cHRlZENvdW50fSBjb3JydXB0ZWQgcHJvamVjdCBlbnRyeSB3YXMgc2tpcHBlZCBzYWZlbHkuYH1cbiAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICl9XG5cbiAgICAgICAgey8qIExvYWRpbmcgc3RhdGUgKi99XG4gICAgICAgIHtpc0xvYWRpbmcgJiYgKFxuICAgICAgICAgIDxkaXZcbiAgICAgICAgICAgIGRhdGEtdGVzdGlkPVwicHJvamVjdHMtbG9hZGluZy1zdGF0ZVwiXG4gICAgICAgICAgICBjbGFzc05hbWU9XCJweS0yMCBmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBnYXAtMyB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXVwiXG4gICAgICAgICAgPlxuICAgICAgICAgICAgPExvYWRlcjIgY2xhc3NOYW1lPVwidy03IGgtNyBhbmltYXRlLXNwaW4gdGV4dC1bdmFyKC0tYXZwLWJyYW5kKV1cIiAvPlxuICAgICAgICAgICAgPHAgY2xhc3NOYW1lPVwidGV4dC1zbSBmb250LW1lZGl1bVwiPlxuICAgICAgICAgICAgICB7aXNGYSA/ICfYr9ixINit2KfZhCDYqNin2LHar9iw2KfYsduMINm+2LHZiNqY2YfigIzZh9inLi4uJyA6ICdMb2FkaW5nIHlvdXIgcHJvamVjdHMuLi4nfVxuICAgICAgICAgICAgPC9wPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICApfVxuXG4gICAgICAgIHsvKiBFcnJvciBzdGF0ZSAqL31cbiAgICAgICAgeyFpc0xvYWRpbmcgJiYgZXJyb3JNZXNzYWdlICYmIChcbiAgICAgICAgICA8ZGl2XG4gICAgICAgICAgICBkYXRhLXRlc3RpZD1cInByb2plY3RzLWVycm9yLXN0YXRlXCJcbiAgICAgICAgICAgIGNsYXNzTmFtZT1cInAtNiByb3VuZGVkLTJ4bCBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtZXJyb3IpXS80MCBiZy1bdmFyKC0tYXZwLXN1cmZhY2UpXSB0ZXh0LWNlbnRlciBzcGFjZS15LTNcIlxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxBbGVydENpcmNsZSBjbGFzc05hbWU9XCJ3LTggaC04IHRleHQtW3ZhcigtLWF2cC1lcnJvcildIG14LWF1dG9cIiAvPlxuICAgICAgICAgICAgPGgyIGNsYXNzTmFtZT1cInRleHQtYmFzZSBmb250LWJvbGRcIj5cbiAgICAgICAgICAgICAge2lzRmEgPyAn2KjYp9ix2q/YsNin2LHbjCDZgdmH2LHYs9iqINm+2LHZiNqY2YfigIzZh9inINmG2KfZhdmI2YHZgiDYqNmI2K8nIDogJ0ZhaWxlZCB0byBsb2FkIHByb2plY3RzJ31cbiAgICAgICAgICAgIDwvaDI+XG4gICAgICAgICAgICA8cCBjbGFzc05hbWU9XCJ0ZXh0LXhzIHRleHQtW3ZhcigtLWF2cC10ZXh0LXNlY29uZGFyeSldIG1heC13LW1kIG14LWF1dG9cIj5cbiAgICAgICAgICAgICAge2Vycm9yTWVzc2FnZX1cbiAgICAgICAgICAgIDwvcD5cbiAgICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgIG9uQ2xpY2s9e29uUmV0cnlMb2FkfVxuICAgICAgICAgICAgICBjbGFzc05hbWU9XCJoLTkgcHgtNCByb3VuZGVkLXhsIGJnLVt2YXIoLS1hdnAtYnJhbmQpXSB0ZXh0LXdoaXRlIHRleHQteHMgZm9udC1zZW1pYm9sZCBpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSBjdXJzb3ItcG9pbnRlclwiXG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIDxSZWZyZXNoQ3cgY2xhc3NOYW1lPVwidy0zLjUgaC0zLjVcIiAvPlxuICAgICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfYqtmE2KfYtCDYr9mI2KjYp9ix2YcnIDogJ1JldHJ5J308L3NwYW4+XG4gICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cblxuICAgICAgICB7LyogRmlyc3QtdGltZSBPbmJvYXJkaW5nIEVtcHR5IFN0YXRlICh3aGVuIHplcm8gcHJvamVjdHMgZXhpc3QpICovfVxuICAgICAgICB7IWlzTG9hZGluZyAmJiAhZXJyb3JNZXNzYWdlICYmIHByb2plY3RzLmxlbmd0aCA9PT0gMCAmJiAoXG4gICAgICAgICAgPGRpdlxuICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJwcm9qZWN0cy1lbXB0eS1zdGF0ZVwiXG4gICAgICAgICAgICBjbGFzc05hbWU9XCJyb3VuZGVkLTN4bCBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyKV0gYmctW3ZhcigtLWF2cC1zdXJmYWNlKV0gcC03IHNtOnAtMTEgc2hhZG93LVt2YXIoLS1hdnAtc2hhZG93LXNtKV0gdGV4dC1jZW50ZXIgbWF4LXctM3hsIG14LWF1dG8gbXktNiBzcGFjZS15LTZcIlxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwidy0xNiBoLTE2IHJvdW5kZWQtMnhsIGJnLVt2YXIoLS1hdnAtYnJhbmQtc29mdCldIHRleHQtW3ZhcigtLWF2cC1icmFuZCldIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG14LWF1dG9cIj5cbiAgICAgICAgICAgICAgPEZpbGVBdWRpbyBjbGFzc05hbWU9XCJ3LTggaC04XCIgLz5cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInNwYWNlLXktMiBtYXgtdy14bCBteC1hdXRvXCI+XG4gICAgICAgICAgICAgIDxoMiBjbGFzc05hbWU9XCJ0ZXh0LXhsIHNtOnRleHQtMnhsIGZvbnQtYm9sZCB0ZXh0LVt2YXIoLS1hdnAtdGV4dCldXCI+XG4gICAgICAgICAgICAgICAge2lzRmFcbiAgICAgICAgICAgICAgICAgID8gJ9io2Ycg2KfYs9iq2YjYr9uM2YjbjCDYqtiv2YjbjNmGINqv2YHYqtin2LEg2KLZiNin2b7Ysdiv2KfYsiDYrtmI2LQg2KLZhdiv24zYrydcbiAgICAgICAgICAgICAgICAgIDogJ1dlbGNvbWUgdG8gQXZhcGFyZGF6IFNwZWVjaCBFZGl0aW5nIFN0dWRpbyd9XG4gICAgICAgICAgICAgIDwvaDI+XG4gICAgICAgICAgICAgIDxwIGNsYXNzTmFtZT1cInRleHQtc20gdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gbGVhZGluZy1yZWxheGVkXCI+XG4gICAgICAgICAgICAgICAge2lzRmFcbiAgICAgICAgICAgICAgICAgID8gJ9mB2KfbjNmEINi12YjYqtuMINqv2YHYqtin2LEg24zYpyDZvtin2K/aqdiz2Kog2K7ZiNivINix2Kcg2YjYp9ix2K8g2qnZhtuM2K/YjCDZhdiq2YYg2LLZhdin2YbigIzYqNmG2K/bjOKAjNi02K/ZhyDYsdinINio2KjbjNmG24zYr9iMINiq2b7ZguKAjNmH2Kcg2Ygg2YXaqdir4oCM2YfYp9uMINin2LbYp9mB2Ycg2LHYpyDYqNinINuM2qkg2qnZhNuM2qkg2KfYtdmE2KfYrSDaqdmG24zYryDZiCDZgdin24zZhCDYtdmI2KrbjCDYqtmF24zYsiDYqtit2YjbjNmEINio2q/bjNix24zYry4nXG4gICAgICAgICAgICAgICAgICA6ICdJbXBvcnQgeW91ciBQZXJzaWFuIHNwZWVjaCBvciBwb2RjYXN0IGF1ZGlvLCBpbnNwZWN0IHRoZSB0aW1lZCB0cmFuc2NyaXB0LCBjbGVhbiB1cCBkaXNmbHVlbmNpZXMgYW5kIHBhdXNlcyB3aXRoIG9uZSBjbGljaywgYW5kIGV4cG9ydCBwb2xpc2hlZCBhdWRpby4nfVxuICAgICAgICAgICAgICA8L3A+XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgZ2FwLTMgcHQtMVwiPlxuICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJidG4tZW1wdHktY3JlYXRlLXByb2plY3RcIlxuICAgICAgICAgICAgICAgIG9uQ2xpY2s9e29uT3Blbk5ld1Byb2plY3RNb2RhbH1cbiAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJoLTExIHB4LTYgcm91bmRlZC14bCBiZy1bdmFyKC0tYXZwLWJyYW5kKV0gaG92ZXI6YmctW3ZhcigtLWF2cC1icmFuZC1ob3ZlcildIHRleHQtd2hpdGUgdGV4dC1zbSBmb250LXNlbWlib2xkIGlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiBzaGFkb3ctW3ZhcigtLWF2cC1zaGFkb3cteHMpXSBjdXJzb3ItcG9pbnRlciB0cmFuc2l0aW9uLWNvbG9yc1wiXG4gICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICA8UGx1cyBjbGFzc05hbWU9XCJ3LTQgaC00XCIgLz5cbiAgICAgICAgICAgICAgICA8c3Bhbj5cbiAgICAgICAgICAgICAgICAgIHtpc0ZhXG4gICAgICAgICAgICAgICAgICAgID8gJ9in24zYrNin2K8g2KfZiNmE24zZhiDZvtix2YjamNmHINio2Kcg2YHYp9uM2YQg2LXZiNiq24wnXG4gICAgICAgICAgICAgICAgICAgIDogJ0NyZWF0ZSBGaXJzdCBQcm9qZWN0IHdpdGggQXVkaW8nfVxuICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgPC9idXR0b24+XG5cbiAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgIGRhdGEtdGVzdGlkPVwiYnRuLW9wZW4tc2FtcGxlLXN0dWRpb1wiXG4gICAgICAgICAgICAgICAgb25DbGljaz17b25PcGVuU2FtcGxlU3R1ZGlvfVxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtMTEgcHgtNSByb3VuZGVkLXhsIGJvcmRlciBib3JkZXItW3ZhcigtLWF2cC1ib3JkZXIpXSBiZy1bdmFyKC0tYXZwLXN1cmZhY2UtMildIGhvdmVyOmJnLVt2YXIoLS1hdnAtaG92ZXIpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dCldIHRleHQteHMgZm9udC1tZWRpdW0gaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGdhcC0yIGN1cnNvci1wb2ludGVyIHRyYW5zaXRpb24tY29sb3JzXCJcbiAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgIDxXYW5kMiBjbGFzc05hbWU9XCJ3LTQgaC00IHRleHQtW3ZhcigtLWF2cC1icmFuZCldXCIgLz5cbiAgICAgICAgICAgICAgICA8c3Bhbj5cbiAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9ii2LLZhdin24zYtCDYqNinINmG2YXZiNmG2Ycg2LXZiNiq24wg2KLZhdin2K/ZhycgOiAnVHJ5IHdpdGggU2FtcGxlIFBlcnNpYW4gQXVkaW8nfVxuICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgey8qIDQtU3RlcCBWaXN1YWwgV29ya2Zsb3cgRXhwbGFuYXRpb24gKi99XG4gICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImdyaWQgZ3JpZC1jb2xzLTEgc206Z3JpZC1jb2xzLTQgZ2FwLTMgcHQtNCB0ZXh0LXN0YXJ0IGJvcmRlci10IGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlci1zdWJ0bGUpXVwiPlxuICAgICAgICAgICAgICB7W1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIG51bTogaXNGYSA/ICfbsScgOiAnMScsXG4gICAgICAgICAgICAgICAgICB0aXRsZTogaXNGYSA/ICfYqNin2LHar9iw2KfYsduMINmB2KfbjNmEINi12YjYqtuMJyA6ICdJbXBvcnQgQXVkaW8nLFxuICAgICAgICAgICAgICAgICAgZGVzYzogaXNGYVxuICAgICAgICAgICAgICAgICAgICA/ICfZvti02KrbjNio2KfZhtuMINin2LIgV0FW2IwgTVAz2IwgTTRB2IwgRkxBQyDZiCBPR0cnXG4gICAgICAgICAgICAgICAgICAgIDogJ1N1cHBvcnRzIFdBViwgTVAzLCBNNEEsIEZMQUMgJiBPR0cnLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgbnVtOiBpc0ZhID8gJ9uyJyA6ICcyJyxcbiAgICAgICAgICAgICAgICAgIHRpdGxlOiBpc0ZhID8gJ9iq2KjYr9uM2YQg2q/Zgdiq2KfYsSDYqNmHINmF2KrZhicgOiAnVHJhbnNjcmliZSBTcGVlY2gnLFxuICAgICAgICAgICAgICAgICAgZGVzYzogaXNGYVxuICAgICAgICAgICAgICAgICAgICA/ICfYp9iz2KrYrtix2KfYrCDaqdmE2YXYp9iqINiy2YXYp9mG4oCM2KjZhtiv24zigIzYtNiv2Ycg2YHYp9ix2LPbjCdcbiAgICAgICAgICAgICAgICAgICAgOiAnV29yZC1sZXZlbCB0aW1lZCBQZXJzaWFuIHRyYW5zY3JpcHQnLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgbnVtOiBpc0ZhID8gJ9uzJyA6ICczJyxcbiAgICAgICAgICAgICAgICAgIHRpdGxlOiBpc0ZhID8gJ9m+24zYtNmG2YfYp9iv2YfYp9uMINmH2YjYtNmF2YbYryDYqtiv2YjbjNmGJyA6ICdTbWFydCBFZGl0IFN1Z2dlc3Rpb25zJyxcbiAgICAgICAgICAgICAgICAgIGRlc2M6IGlzRmFcbiAgICAgICAgICAgICAgICAgICAgPyAn2K3YsNmBINmF2qnYq+KAjNmH2KfbjCDYt9mI2YTYp9mG24zYjCDYqtm+2YLigIzZh9inINmIINiq2qnYsdin2LHZh9inJ1xuICAgICAgICAgICAgICAgICAgICA6ICdDbGVhbiBsb25nIHBhdXNlcywgZmlsbGVycyAmIHJlcGVhdHMnLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgbnVtOiBpc0ZhID8gJ9u0JyA6ICc0JyxcbiAgICAgICAgICAgICAgICAgIHRpdGxlOiBpc0ZhID8gJ9iu2LHZiNis24wg2YbZh9in24zbjCDYqtmF24zYsicgOiAnUG9saXNoZWQgRXhwb3J0JyxcbiAgICAgICAgICAgICAgICAgIGRlc2M6IGlzRmFcbiAgICAgICAgICAgICAgICAgICAgPyAn2K/YsduM2KfZgdiqINmB2KfbjNmEINi12YjYqtuMINiq2K/ZiNuM2YbigIzYtNiv2Ycg2KjYpyDYqNmE2YbYr9uMINin2LPYqtin2YbYr9in2LHYrydcbiAgICAgICAgICAgICAgICAgICAgOiAnRXhwb3J0IG1hc3RlcmVkIFdBViBvciBGTEFDIGF1ZGlvJyxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBdLm1hcCgoc3RlcCkgPT4gKFxuICAgICAgICAgICAgICAgIDxkaXZcbiAgICAgICAgICAgICAgICAgIGtleT17c3RlcC5udW19XG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJwLTMuNSByb3VuZGVkLTJ4bCBiZy1bdmFyKC0tYXZwLWJnKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlci1zdWJ0bGUpXSBzcGFjZS15LTFcIlxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cInctNiBoLTYgcm91bmRlZC1sZyBiZy1bdmFyKC0tYXZwLWJyYW5kLXNvZnQpXSB0ZXh0LVt2YXIoLS1hdnAtYnJhbmQpXSB0ZXh0LXhzIGZvbnQtYm9sZCBpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXJcIj5cbiAgICAgICAgICAgICAgICAgICAge3N0ZXAubnVtfVxuICAgICAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJ0ZXh0LXhzIGZvbnQtYm9sZCB0ZXh0LVt2YXIoLS1hdnAtdGV4dCldIHB0LTFcIj57c3RlcC50aXRsZX08L2Rpdj5cbiAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwidGV4dC1bMTFweF0gdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gbGVhZGluZy1yZWxheGVkXCI+XG4gICAgICAgICAgICAgICAgICAgIHtzdGVwLmRlc2N9XG4gICAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgKSl9XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cblxuICAgICAgICB7LyogUHJvamVjdHMgTGlzdCAmIEZpbHRlciBUb29sYmFyICh3aGVuIHByb2plY3RzIGV4aXN0KSAqL31cbiAgICAgICAgeyFpc0xvYWRpbmcgJiYgIWVycm9yTWVzc2FnZSAmJiBwcm9qZWN0cy5sZW5ndGggPiAwICYmIChcbiAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInNwYWNlLXktNVwiPlxuICAgICAgICAgICAgey8qIFNlY3Rpb24gVGl0bGUgJiBGaWx0ZXIgQmFyICovfVxuICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGZsZXgtY29sIG1kOmZsZXgtcm93IG1kOml0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIj5cbiAgICAgICAgICAgICAgPGRpdj5cbiAgICAgICAgICAgICAgICA8aDIgY2xhc3NOYW1lPVwidGV4dC1sZyBmb250LWJvbGQgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIj5cbiAgICAgICAgICAgICAgICAgIDxGb2xkZXJPcGVuIGNsYXNzTmFtZT1cInctNSBoLTUgdGV4dC1bdmFyKC0tYXZwLWJyYW5kKV1cIiAvPlxuICAgICAgICAgICAgICAgICAgPHNwYW4+e2lzRmEgPyAn2b7YsdmI2pjZh+KAjNmH2KfbjCDYtNmF2KcnIDogJ1lvdXIgUHJvamVjdHMnfTwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cInRleHQteHMgZm9udC1tZWRpdW0gcHgtMiBweS0wLjUgcm91bmRlZC1mdWxsIGJnLVt2YXIoLS1hdnAtc3VyZmFjZS0yKV0gdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV1cIj5cbiAgICAgICAgICAgICAgICAgICAge3Byb2plY3RzLmxlbmd0aH1cbiAgICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgICA8L2gyPlxuICAgICAgICAgICAgICAgIDxwIGNsYXNzTmFtZT1cInRleHQteHMgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gbXQtMC41XCI+XG4gICAgICAgICAgICAgICAgICB7aXNGYVxuICAgICAgICAgICAgICAgICAgICA/ICfYqNix2KfbjCDYp9iv2KfZhdmHINiq2K/ZiNuM2YYg2LHZiNuMINmH2LEg2b7YsdmI2pjZhyDaqdmE24zaqSDaqdmG24zYryDbjNinINm+2LHZiNqY2Ycg2KzYr9uM2K/bjCDYqNiz2KfYstuM2K8uJ1xuICAgICAgICAgICAgICAgICAgICA6ICdDbGljayBhbnkgcHJvamVjdCB0byByZXN1bWUgZWRpdGluZyBpbiB0aGUgc3R1ZGlvIG9yIGNyZWF0ZSBhIG5ldyBwcm9qZWN0Lid9XG4gICAgICAgICAgICAgICAgPC9wPlxuICAgICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgICB7LyogU2VhcmNoLCBTdGF0dXMgRmlsdGVyLCBTb3J0ICYgR3JpZC9UYWJsZSBWaWV3IE1vZGUgU3dpdGNoZXIgKi99XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGdhcC0yXCI+XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJyZWxhdGl2ZSBmbGV4LTEgc206ZmxleC1pbml0aWFsIHNtOnctNjRcIj5cbiAgICAgICAgICAgICAgICAgIDxTZWFyY2ggY2xhc3NOYW1lPVwidy0zLjUgaC0zLjUgdGV4dC1bdmFyKC0tYXZwLXRleHQtbXV0ZWQpXSBhYnNvbHV0ZSB0b3AtMS8yIC10cmFuc2xhdGUteS0xLzIgc3RhcnQtMyBwb2ludGVyLWV2ZW50cy1ub25lXCIgLz5cbiAgICAgICAgICAgICAgICAgIDxpbnB1dFxuICAgICAgICAgICAgICAgICAgICB0eXBlPVwic2VhcmNoXCJcbiAgICAgICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJwcm9qZWN0cy1zZWFyY2gtaW5wdXRcIlxuICAgICAgICAgICAgICAgICAgICB2YWx1ZT17c2VhcmNoUXVlcnl9XG4gICAgICAgICAgICAgICAgICAgIG9uQ2hhbmdlPXsoZSkgPT4gc2V0U2VhcmNoUXVlcnkoZS50YXJnZXQudmFsdWUpfVxuICAgICAgICAgICAgICAgICAgICBwbGFjZWhvbGRlcj17XG4gICAgICAgICAgICAgICAgICAgICAgaXNGYSA/ICfYrNiz2KrYrNmIINiv2LEg2YbYp9mFINm+2LHZiNqY2Ycg24zYpyDZgdin24zZhC4uLicgOiAnU2VhcmNoIHByb2plY3Qgb3IgZmlsZS4uLidcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJ3LWZ1bGwgaC05IHBzLTggcGUtMyByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLW1kKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHRleHQteHMgdGV4dC1bdmFyKC0tYXZwLXRleHQpXSBwbGFjZWhvbGRlcjp0ZXh0LVt2YXIoLS1hdnAtdGV4dC1tdXRlZCldIGZvY3VzOm91dGxpbmUtbm9uZSBmb2N1czpib3JkZXItW3ZhcigtLWF2cC1icmFuZCldXCJcbiAgICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgICAgICA8c2VsZWN0XG4gICAgICAgICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gJ9mB24zZhNiq2LEg2YjYtti524zYqiDZvtix2YjamNmHJyA6ICdGaWx0ZXIgYnkgc3RhdHVzJ31cbiAgICAgICAgICAgICAgICAgIGRhdGEtdGVzdGlkPVwicHJvamVjdHMtc3RhdHVzLWZpbHRlclwiXG4gICAgICAgICAgICAgICAgICB2YWx1ZT17c3RhdHVzRmlsdGVyfVxuICAgICAgICAgICAgICAgICAgb25DaGFuZ2U9eyhlKSA9PiBzZXRTdGF0dXNGaWx0ZXIoZS50YXJnZXQudmFsdWUgYXMgUHJvamVjdEZpbHRlclRhYil9XG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJoLTkgcHgtMyByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLW1kKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHRleHQteHMgdGV4dC1bdmFyKC0tYXZwLXRleHQpXSBjdXJzb3ItcG9pbnRlclwiXG4gICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cImFsbFwiPntpc0ZhID8gJ9mH2YXZhyDZiNi22LnbjNiq4oCM2YfYpycgOiAnQWxsIHN0YXR1c2VzJ308L29wdGlvbj5cbiAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJyZWNlbnRcIj57aXNGYSA/ICfYp9iu24zYsScgOiAnUmVjZW50J308L29wdGlvbj5cbiAgICAgICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9XCJlZGl0aW5nXCI+e2lzRmEgPyAn2K/YsSDYrdin2YQg2KrYr9mI24zZhicgOiAnRWRpdGluZyAmIFJldmlldyd9PC9vcHRpb24+XG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwiY29tcGxldGVkXCI+e2lzRmEgPyAn2KraqdmF24zZhOKAjNi02K/ZhycgOiAnQ29tcGxldGVkJ308L29wdGlvbj5cbiAgICAgICAgICAgICAgICA8L3NlbGVjdD5cblxuICAgICAgICAgICAgICAgIDxzZWxlY3RcbiAgICAgICAgICAgICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2YXYsdiq2KjigIzYs9in2LLbjCDZvtix2YjamNmH4oCM2YfYpycgOiAnU29ydCBwcm9qZWN0cyd9XG4gICAgICAgICAgICAgICAgICBkYXRhLXRlc3RpZD1cInByb2plY3RzLXNvcnQtc2VsZWN0XCJcbiAgICAgICAgICAgICAgICAgIHZhbHVlPXtzb3J0Qnl9XG4gICAgICAgICAgICAgICAgICBvbkNoYW5nZT17KGUpID0+IHNldFNvcnRCeShlLnRhcmdldC52YWx1ZSBhcyBQcm9qZWN0U29ydEZpZWxkKX1cbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtOSBweC0zIHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMtbWQpXSBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyKV0gYmctW3ZhcigtLWF2cC1zdXJmYWNlKV0gdGV4dC14cyB0ZXh0LVt2YXIoLS1hdnAtdGV4dCldIGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwidXBkYXRlZEF0XCI+XG4gICAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9ii2K7YsduM2YYg2YjbjNix2KfbjNi0JyA6ICdMYXN0IG1vZGlmaWVkJ31cbiAgICAgICAgICAgICAgICAgIDwvb3B0aW9uPlxuICAgICAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT1cImxhc3RPcGVuZWRBdFwiPlxuICAgICAgICAgICAgICAgICAgICB7aXNGYSA/ICfYotiu2LHbjNmGINio2KfYstiv24zYrycgOiAnTGFzdCBvcGVuZWQnfVxuICAgICAgICAgICAgICAgICAgPC9vcHRpb24+XG4gICAgICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPVwibmFtZVwiPntpc0ZhID8gJ9mG2KfZhSAo2KfZhNmB2KjYp9uM24wpJyA6ICdOYW1lIChB4oCTWiknfTwvb3B0aW9uPlxuICAgICAgICAgICAgICAgIDwvc2VsZWN0PlxuXG4gICAgICAgICAgICAgICAgey8qIEdyaWQgfCBUYWJsZSBWaWV3IE1vZGUgU3dpdGNoZXIgKEJsdWVwcmludCAxIC0gUDItMSkgKi99XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJhdnAtc2VnbWVudGVkXCI+XG4gICAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgICAgICBkYXRhLXRlc3RpZD1cImJ0bi1wcm9qZWN0cy12aWV3LWdyaWRcIlxuICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiBzZXRWaWV3TW9kZSgnZ3JpZCcpfVxuICAgICAgICAgICAgICAgICAgICBhcmlhLXByZXNzZWQ9e3ZpZXdNb2RlID09PSAnZ3JpZCd9XG4gICAgICAgICAgICAgICAgICAgIHRpdGxlPXtpc0ZhID8gJ9mG2YXYp9uMINqp2KfYsdiq24wnIDogJ0NhcmQgR3JpZCBWaWV3J31cbiAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiYXZwLXNlZ21lbnRlZC1pdGVtIGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgPExheW91dEdyaWQgY2xhc3NOYW1lPVwidy0zLjUgaC0zLjVcIiAvPlxuICAgICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9XCJoaWRkZW4gc206aW5saW5lXCI+e2lzRmEgPyAn2qnYp9ix2KonIDogJ0dyaWQnfTwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJidG4tcHJvamVjdHMtdmlldy10YWJsZVwiXG4gICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHNldFZpZXdNb2RlKCd0YWJsZScpfVxuICAgICAgICAgICAgICAgICAgICBhcmlhLXByZXNzZWQ9e3ZpZXdNb2RlID09PSAndGFibGUnfVxuICAgICAgICAgICAgICAgICAgICB0aXRsZT17aXNGYSA/ICfZhtmF2KfbjCDYrNiv2YjZhNuMINmB2LTYsdiv2YcnIDogJ0NvbXBhY3QgVGFibGUgVmlldyd9XG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImF2cC1zZWdtZW50ZWQtaXRlbSBjdXJzb3ItcG9pbnRlclwiXG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIDxMaXN0IGNsYXNzTmFtZT1cInctMy41IGgtMy41XCIgLz5cbiAgICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3NOYW1lPVwiaGlkZGVuIHNtOmlubGluZVwiPntpc0ZhID8gJ9is2K/ZiNmEJyA6ICdUYWJsZSd9PC9zcGFuPlxuICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIHsvKiBGaWx0ZXJlZCBFbXB0eSBTZWFyY2ggUmVzdWx0ICovfVxuICAgICAgICAgICAge2ZpbHRlcmVkUHJvamVjdHMubGVuZ3RoID09PSAwID8gKFxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInJvdW5kZWQtMnhsIGJvcmRlciBib3JkZXItW3ZhcigtLWF2cC1ib3JkZXIpXSBiZy1bdmFyKC0tYXZwLXN1cmZhY2UpXSBwLTEwIHRleHQtY2VudGVyIHNwYWNlLXktMlwiPlxuICAgICAgICAgICAgICAgIDxwIGNsYXNzTmFtZT1cInRleHQtc20gZm9udC1zZW1pYm9sZFwiPlxuICAgICAgICAgICAgICAgICAge2lzRmFcbiAgICAgICAgICAgICAgICAgICAgPyAn2YfbjNqGINm+2LHZiNqY2YfigIzYp9uMINio2Kcg2KzYs9iq2KzZiNuMINi02YXYpyDZhdi32KfYqNmC2Kog2YbYr9in2LHYrydcbiAgICAgICAgICAgICAgICAgICAgOiAnTm8gbWF0Y2hpbmcgcHJvamVjdHMgZm91bmQnfVxuICAgICAgICAgICAgICAgIDwvcD5cbiAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgc2V0U2VhcmNoUXVlcnkoJycpO1xuICAgICAgICAgICAgICAgICAgICBzZXRTdGF0dXNGaWx0ZXIoJ2FsbCcpO1xuICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInRleHQteHMgdGV4dC1bdmFyKC0tYXZwLWJyYW5kKV0gaG92ZXI6dW5kZXJsaW5lIGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICB7aXNGYSA/ICfZvtin2qkg2qnYsdiv2YYg2YHbjNmE2KrYsdmH2KcnIDogJ1Jlc2V0IGZpbHRlcnMnfVxuICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICkgOiB2aWV3TW9kZSA9PT0gJ2dyaWQnID8gKFxuICAgICAgICAgICAgICAvKiBQcm9qZWN0IENhcmRzIEdyaWQgKDMtQ29sdW1uIFJlc3BvbnNpdmUgRGVza3RvcCBHcmlkKSAqL1xuICAgICAgICAgICAgICA8ZGl2XG4gICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJwcm9qZWN0cy1ncmlkXCJcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJncmlkIGdyaWQtY29scy0xIG1kOmdyaWQtY29scy0yIGxnOmdyaWQtY29scy0zIGdhcC00XCJcbiAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgIHtmaWx0ZXJlZFByb2plY3RzLm1hcCgoaXRlbSkgPT4ge1xuICAgICAgICAgICAgICAgICAgY29uc3QgaXNNZW51T3BlbiA9IG9wZW5NZW51SWQgPT09IGl0ZW0uaWQ7XG4gICAgICAgICAgICAgICAgICBjb25zdCBpc1JlbmFtaW5nID0gcmVuYW1pbmdJZCA9PT0gaXRlbS5pZDtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGlzUGxheWluZ1ByZXZpZXcgPSBwcmV2aWV3UGxheWluZ0lkID09PSBpdGVtLmlkO1xuICAgICAgICAgICAgICAgICAgY29uc3QgZXh0QmFkZ2UgPSAoXG4gICAgICAgICAgICAgICAgICAgIGl0ZW0uc291cmNlRmlsZU5hbWUuc3BsaXQoJy4nKS5wb3AoKSB8fCAnV0FWJ1xuICAgICAgICAgICAgICAgICAgKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICAgICAgICAgICAgY29uc3QgcGVha3M6IHJlYWRvbmx5IG51bWJlcltdID0gaXRlbS53YXZlZm9ybVByZXZpZXdQZWFrcz8ubGVuZ3RoXG4gICAgICAgICAgICAgICAgICAgID8gaXRlbS53YXZlZm9ybVByZXZpZXdQZWFrc1xuICAgICAgICAgICAgICAgICAgICA6IFswLjMsIDAuNTUsIDAuNCwgMC44LCAwLjUsIDAuNjUsIDAuNDIsIDAuNzQsIDAuNTEsIDAuODgsIDAuMzYsIDAuNjJdO1xuXG4gICAgICAgICAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgICAgICAgICA8YXJ0aWNsZVxuICAgICAgICAgICAgICAgICAgICAgIGtleT17aXRlbS5pZH1cbiAgICAgICAgICAgICAgICAgICAgICBkYXRhLXRlc3RpZD17YHByb2plY3QtY2FyZC0ke2l0ZW0uaWR9YH1cbiAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzUmVuYW1pbmcpIG9uT3BlblByb2plY3QoaXRlbS5pZCk7XG4gICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJncm91cCByZWxhdGl2ZSByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLWxnKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZSldIGhvdmVyOmJvcmRlci1bdmFyKC0tYXZwLWJyYW5kKV0vNjAgcC00IHNoYWRvdy1bdmFyKC0tYXZwLXNoYWRvdy14cyldIGhvdmVyOnNoYWRvdy1bdmFyKC0tYXZwLXNoYWRvdy1zbSldIHRyYW5zaXRpb24tYWxsIGZsZXggZmxleC1jb2wganVzdGlmeS1iZXR3ZWVuIGdhcC00IGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgIHsvKiBUb3AgSGVhZGVyOiBTdGF0dXMgQmFkZ2UgKyBDb250ZXh0IE1lbnUgKi99XG4gICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtMlwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgPHNwYW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPXtgaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gcHgtMi41IHB5LTAuNSByb3VuZGVkLWZ1bGwgYm9yZGVyICR7Z2V0U3RhdHVzQmFkZ2VDbGFzc2VzKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGl0ZW0uc3RhdHVzLFxuICAgICAgICAgICAgICAgICAgICAgICAgICApfWB9XG4gICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHtpdGVtLnN0YXR1cyA9PT0gJ3JldmlldycgJiYgKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxTcGFya2xlcyBjbGFzc05hbWU9XCJ3LTMgaC0zXCIgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAge2l0ZW0uc3RhdHVzID09PSAnY29tcGxldGVkJyAmJiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPENoZWNrQ2lyY2xlMiBjbGFzc05hbWU9XCJ3LTMgaC0zXCIgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAge2Zvcm1hdFByb2plY3RTdGF0dXNMYWJlbChpdGVtLnN0YXR1cywgbG9jYWxlKX1cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvc3Bhbj5cblxuICAgICAgICAgICAgICAgICAgICAgICAgPGRpdlxuICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJyZWxhdGl2ZVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eyhlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEtdGVzdGlkPXtgcHJvamVjdC1tZW51LWJ0bi0ke2l0ZW0uaWR9YH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcmlhLWxhYmVsPXtpc0ZhID8gJ9i52YXZhNuM2KfYqiDZvtix2YjamNmHJyA6ICdQcm9qZWN0IGFjdGlvbnMnfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRPcGVuTWVudUlkKGlzTWVudU9wZW4gPyBudWxsIDogaXRlbS5pZClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwidy03IGgtNyByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLXNtKV0gdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gaG92ZXI6YmctW3ZhcigtLWF2cC1ob3ZlcildIGhvdmVyOnRleHQtW3ZhcigtLWF2cC10ZXh0KV0gaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxNb3JlVmVydGljYWwgY2xhc3NOYW1lPVwidy00IGgtNFwiIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgIHtpc01lbnVPcGVuICYmIChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImFic29sdXRlIGVuZC0wIG10LTEgdy00NCByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLW1kKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHNoYWRvdy1bdmFyKC0tYXZwLXNoYWRvdy1tZCldIHB5LTEgei0yMCB0ZXh0LXhzXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkYXRhLXRlc3RpZD17YHByb2plY3QtcmVuYW1lLWJ0bi0ke2l0ZW0uaWR9YH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25DbGljaz17KCkgPT4gaGFuZGxlU3RhcnRSZW5hbWUoaXRlbSl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInctZnVsbCBweC0zIHB5LTIgdGV4dC1zdGFydCBob3ZlcjpiZy1bdmFyKC0tYXZwLWhvdmVyKV0gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIgY3Vyc29yLXBvaW50ZXJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8RWRpdDMgY2xhc3NOYW1lPVwidy0zLjUgaC0zLjUgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV1cIiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfYqti624zbjNixINmG2KfZhSDZvtix2YjamNmHJyA6ICdSZW5hbWUnfTwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9e2Bwcm9qZWN0LWR1cGxpY2F0ZS1idG4tJHtpdGVtLmlkfWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRPcGVuTWVudUlkKG51bGwpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZvaWQgb25EdXBsaWNhdGVQcm9qZWN0KGl0ZW0uaWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJ3LWZ1bGwgcHgtMyBweS0yIHRleHQtc3RhcnQgaG92ZXI6YmctW3ZhcigtLWF2cC1ob3ZlcildIGZsZXggaXRlbXMtY2VudGVyIGdhcC0yIGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPENvcHkgY2xhc3NOYW1lPVwidy0zLjUgaC0zLjUgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV1cIiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfYqtqp2KvbjNixINm+2LHZiNqY2YcnIDogJ0R1cGxpY2F0ZSd9PC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cIm15LTEgYm9yZGVyLXQgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyLXN1YnRsZSldXCIgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEtdGVzdGlkPXtgcHJvamVjdC1kZWxldGUtYnRuLSR7aXRlbS5pZH1gfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0T3Blbk1lbnVJZChudWxsKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRDb25maXJtRGVsZXRlSXRlbShpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwidy1mdWxsIHB4LTMgcHktMiB0ZXh0LXN0YXJ0IGhvdmVyOmJnLVt2YXIoLS1hdnAtZXJyb3IpXS8xMCB0ZXh0LVt2YXIoLS1hdnAtZXJyb3IpXSBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiBjdXJzb3ItcG9pbnRlclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUcmFzaDIgY2xhc3NOYW1lPVwidy0zLjUgaC0zLjVcIiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3Bhbj57aXNGYSA/ICfYrdiw2YEg2b7YsdmI2pjZhycgOiAnRGVsZXRlJ308L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICAgICAgICAgICAgey8qIFRpdGxlICsgQXVkaW8gRmlsZW5hbWUgKyBUZWNobmljYWwgU3BlYyBCYWRnZSAqL31cbiAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInNwYWNlLXktMS41XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICB7aXNSZW5hbWluZyA/IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjVcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eyhlKSA9PiBlLnN0b3BQcm9wYWdhdGlvbigpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGlucHV0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlPVwidGV4dFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhdXRvRm9jdXNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlPXtyZW5hbWVEcmFmdH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2hhbmdlPXsoZSkgPT4gc2V0UmVuYW1lRHJhZnQoZS50YXJnZXQudmFsdWUpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25LZXlEb3duPXsoZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZS5rZXkgPT09ICdFbnRlcicpIHZvaWQgaGFuZGxlQ29tbWl0UmVuYW1lKGl0ZW0uaWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZS5rZXkgPT09ICdFc2NhcGUnKSBzZXRSZW5hbWluZ0lkKG51bGwpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImZsZXgtMSBoLTggcHgtMi41IHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJyYW5kKV0gYmctW3ZhcigtLWF2cC1iZyldIHRleHQteHMgZm9udC1zZW1pYm9sZCBmb2N1czpvdXRsaW5lLW5vbmVcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiB2b2lkIGhhbmRsZUNvbW1pdFJlbmFtZShpdGVtLmlkKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtOCBweC0yLjUgcm91bmRlZC1sZyBiZy1bdmFyKC0tYXZwLWJyYW5kKV0gdGV4dC13aGl0ZSB0ZXh0LXhzIGZvbnQtc2VtaWJvbGQgY3Vyc29yLXBvaW50ZXJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9ir2KjYqicgOiAnU2F2ZSd9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPGgzIGNsYXNzTmFtZT1cInRleHQtYmFzZSBmb250LWJvbGQgdGV4dC1bdmFyKC0tYXZwLXRleHQpXSBncm91cC1ob3Zlcjp0ZXh0LVt2YXIoLS1hdnAtYnJhbmQpXSB0cmFuc2l0aW9uLWNvbG9ycyBsaW5lLWNsYW1wLTFcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7aXRlbS5uYW1lfVxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L2gzPlxuICAgICAgICAgICAgICAgICAgICAgICAgKX1cblxuICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgdGV4dC14cyB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXVwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgdHJ1bmNhdGVcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8RmlsZUF1ZGlvIGNsYXNzTmFtZT1cInctMy41IGgtMy41IHRleHQtW3ZhcigtLWF2cC10ZXh0LW11dGVkKV0gc2hyaW5rLTBcIiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cInRydW5jYXRlXCIgZGlyPVwibHRyXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7aXRlbS5zb3VyY2VGaWxlTmFtZX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9XCJzaHJpbmstMCBmb250LW1vbm8gdGV4dC1bOS41cHhdIHB4LTEuNSBweS0wLjUgcm91bmRlZC1bdmFyKC0tYXZwLXJhZGl1cy14cyldIGJnLVt2YXIoLS1hdnAtc3VyZmFjZS0yKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlci1zdWJ0bGUpXSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXVwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtNYXRoLnJvdW5kKChpdGVtLnNhbXBsZVJhdGUgfHwgNDgwMDApIC8gMTAwMCl9a0h6IMK3IHtleHRCYWRnZX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgICAgICAgICAgICB7LyogTWluaSBXYXZlZm9ybSBQcmV2aWV3IEJhciArIDI4eDI4IFF1aWNrIEF1ZGl0aW9uIFBsYXkgQnV0dG9uIChCbHVlcHJpbnQgMSAtIFAyLTEpICovfVxuICAgICAgICAgICAgICAgICAgICAgIDxkaXZcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyaWEtaGlkZGVuPVwidHJ1ZVwiXG4gICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJoLTEwIHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMtbWQpXSBiZy1bdmFyKC0tYXZwLWJnKV0gYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlci1zdWJ0bGUpXSBweC0yLjUgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIlxuICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eyhlKSA9PiBoYW5kbGVUb2dnbGVRdWlja1ByZXZpZXcoZSwgaXRlbSl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGRhdGEtdGVzdGlkPXtgcHJvamVjdC1wcmV2aWV3LXBsYXktJHtpdGVtLmlkfWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHRpdGxlPXtpc0ZhID8gJ9m+24zYtOKAjNi02YbZiNivINiz2LHbjNi5INi12YjYqiDZvtix2YjamNmHJyA6ICdRdWljayBBdWRpbyBBdWRpdGlvbid9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGFyaWEtbGFiZWw9e2lzRmEgPyAn2b7bjNi04oCM2LTZhtmI2K8g2LPYsduM2Lkg2LXZiNiqINm+2LHZiNqY2YcnIDogJ1F1aWNrIEF1ZGlvIEF1ZGl0aW9uJ31cbiAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPXtgdy03IGgtNyByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLXNtKV0gc2hyaW5rLTAgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYm9yZGVyIHRyYW5zaXRpb24tYWxsIGN1cnNvci1wb2ludGVyICR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNQbGF5aW5nUHJldmlld1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyAnYmctW3ZhcigtLWF2cC1icmFuZCldIHRleHQtd2hpdGUgYm9yZGVyLVt2YXIoLS1hdnAtYnJhbmQpXSBzaGFkb3ctW3ZhcigtLWF2cC1zaGFkb3cteHMpXSdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogJ2JnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHRleHQtW3ZhcigtLWF2cC1icmFuZCldIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGhvdmVyOmJvcmRlci1bdmFyKC0tYXZwLWJyYW5kKV0vNjAgaG92ZXI6YmctW3ZhcigtLWF2cC1icmFuZC1zb2Z0KV0nXG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1gfVxuICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICB7aXNQbGF5aW5nUHJldmlldyA/IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8U3F1YXJlIGNsYXNzTmFtZT1cInctMyBoLTMgZmlsbC1jdXJyZW50XCIgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8UGxheSBjbGFzc05hbWU9XCJ3LTMgaC0zIGZpbGwtY3VycmVudFwiIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleC0xIGgtZnVsbCBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtWzNweF0gb3ZlcmZsb3ctaGlkZGVuXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHtwZWFrcy5zbGljZSgwLCAyOCkubWFwKChhbXA6IG51bWJlciwgaWR4OiBudW1iZXIpID0+IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5PXtpZHh9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9e2BmbGV4LTEgcm91bmRlZC1mdWxsIHRyYW5zaXRpb24tY29sb3JzICR7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzUGxheWluZ1ByZXZpZXdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/ICdiZy1bdmFyKC0tYXZwLWJyYW5kKV0gYW5pbWF0ZS1wdWxzZSdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6ICdiZy1bdmFyKC0tYXZwLWJyYW5kKV0vMzUgZ3JvdXAtaG92ZXI6YmctW3ZhcigtLWF2cC1icmFuZCldLzY1J1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdHlsZT17e1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IGAke01hdGgubWF4KDE4LCBNYXRoLm1pbig5MiwgTWF0aC5yb3VuZChhbXAgKiAxMDApKSl9JWAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICkpfVxuICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgICAgICAgICAgICB7LyogQm90dG9tIE1ldGFkYXRhIEZvb3RlciAqL31cbiAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInB0LTIgYm9yZGVyLXQgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyLXN1YnRsZSldIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiB0ZXh0LVsxMXB4XSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXVwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtM1wiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBmb250LW1vbm9cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpcj1cImx0clwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8Q2xvY2sgY2xhc3NOYW1lPVwidy0zIGgtM1wiIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge2Zvcm1hdEF1ZGlvRHVyYXRpb25DbG9jayhpdGVtLmR1cmF0aW9uU2VjKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPC9zcGFuPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8c3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7aXRlbS53b3JkQ291bnQgPiAwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGlzRmFcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBgJHtpdGVtLndvcmRDb3VudH0g2qnZhNmF2YdgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogYCR7aXRlbS53b3JkQ291bnR9IHdvcmRzYFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBpc0ZhXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gJ9io2K/ZiNmGINmF2KrZhidcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiAnTm8gdHJhbnNjcmlwdCd9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgdGV4dC1bdmFyKC0tYXZwLWJyYW5kKV0gZm9udC1zZW1pYm9sZFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9XCJ0ZXh0LVt2YXIoLS1hdnAtdGV4dC1tdXRlZCldIGZvbnQtbm9ybWFsXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge2Zvcm1hdFJlbGF0aXZlTW9kaWZpZWRUaW1lKGl0ZW0udXBkYXRlZEF0TXMsIGxvY2FsZSl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPFBsYXkgY2xhc3NOYW1lPVwidy0zIGgtMyBmaWxsLWN1cnJlbnQgbXMtMSBvcGFjaXR5LTAgZ3JvdXAtaG92ZXI6b3BhY2l0eS0xMDAgdHJhbnNpdGlvbi1vcGFjaXR5XCIgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICAgICAgICA8L2FydGljbGU+XG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0pfVxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgIC8qIEhpZ2gtRGVuc2l0eSBTdHVkaW8gVGFibGUgVmlldyAoQmx1ZXByaW50IDEgLSBQMi0xKSAqL1xuICAgICAgICAgICAgICA8ZGl2XG4gICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9XCJwcm9qZWN0cy10YWJsZVwiXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwicm91bmRlZC1bdmFyKC0tYXZwLXJhZGl1cy1sZyldIGJvcmRlciBib3JkZXItW3ZhcigtLWF2cC1ib3JkZXIpXSBiZy1bdmFyKC0tYXZwLXN1cmZhY2UpXSBvdmVyZmxvdy1oaWRkZW4gc2hhZG93LVt2YXIoLS1hdnAtc2hhZG93LXhzKV1cIlxuICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgPHRhYmxlIGNsYXNzTmFtZT1cInctZnVsbCB0ZXh0LXhzIGJvcmRlci1jb2xsYXBzZVwiPlxuICAgICAgICAgICAgICAgICAgPHRoZWFkPlxuICAgICAgICAgICAgICAgICAgICA8dHIgY2xhc3NOYW1lPVwiaC05IGJvcmRlci1iIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZS0yKV0gdGV4dC1bMTFweF0gdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV1cIj5cbiAgICAgICAgICAgICAgICAgICAgICA8dGggY2xhc3NOYW1lPVwicHgtMyB0ZXh0LXN0YXJ0IGZvbnQtc2VtaWJvbGRcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9mG2KfZhSDZvtix2YjamNmHJyA6ICdQcm9qZWN0IE5hbWUnfVxuICAgICAgICAgICAgICAgICAgICAgIDwvdGg+XG4gICAgICAgICAgICAgICAgICAgICAgPHRoIGNsYXNzTmFtZT1cInB4LTMgdGV4dC1zdGFydCBmb250LXNlbWlib2xkIGhpZGRlbiBzbTp0YWJsZS1jZWxsXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICB7aXNGYSA/ICfZgdin24zZhCDYtdmI2KrbjCcgOiAnU291cmNlIEF1ZGlvJ31cbiAgICAgICAgICAgICAgICAgICAgICA8L3RoPlxuICAgICAgICAgICAgICAgICAgICAgIDx0aCBjbGFzc05hbWU9XCJweC0zIHRleHQtc3RhcnQgZm9udC1zZW1pYm9sZFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAge2lzRmEgPyAn2YjYtti524zYqicgOiAnU3RhdHVzJ31cbiAgICAgICAgICAgICAgICAgICAgICA8L3RoPlxuICAgICAgICAgICAgICAgICAgICAgIDx0aCBjbGFzc05hbWU9XCJweC0zIHRleHQtc3RhcnQgZm9udC1zZW1pYm9sZFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAge2lzRmEgPyAn2YXYr9iq4oCM2LLZhdin2YYnIDogJ0R1cmF0aW9uJ31cbiAgICAgICAgICAgICAgICAgICAgICA8L3RoPlxuICAgICAgICAgICAgICAgICAgICAgIDx0aCBjbGFzc05hbWU9XCJweC0zIHRleHQtc3RhcnQgZm9udC1zZW1pYm9sZCBoaWRkZW4gbWQ6dGFibGUtY2VsbFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAge2lzRmEgPyAn2KrYudiv2KfYryDaqdmE2YXYp9iqJyA6ICdXb3Jkcyd9XG4gICAgICAgICAgICAgICAgICAgICAgPC90aD5cbiAgICAgICAgICAgICAgICAgICAgICA8dGggY2xhc3NOYW1lPVwicHgtMyB0ZXh0LXN0YXJ0IGZvbnQtc2VtaWJvbGQgaGlkZGVuIGxnOnRhYmxlLWNlbGxcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgIHtpc0ZhID8gJ9ii2K7YsduM2YYg2YjbjNix2KfbjNi0JyA6ICdNb2RpZmllZCd9XG4gICAgICAgICAgICAgICAgICAgICAgPC90aD5cbiAgICAgICAgICAgICAgICAgICAgICA8dGggY2xhc3NOYW1lPVwicHgtMyB0ZXh0LWVuZCBmb250LXNlbWlib2xkXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICB7aXNGYSA/ICfYudmF2YTbjNin2KonIDogJ0FjdGlvbnMnfVxuICAgICAgICAgICAgICAgICAgICAgIDwvdGg+XG4gICAgICAgICAgICAgICAgICAgIDwvdHI+XG4gICAgICAgICAgICAgICAgICA8L3RoZWFkPlxuICAgICAgICAgICAgICAgICAgPHRib2R5IGNsYXNzTmFtZT1cImRpdmlkZS15IGRpdmlkZS1bdmFyKC0tYXZwLWJvcmRlci1zdWJ0bGUpXVwiPlxuICAgICAgICAgICAgICAgICAgICB7ZmlsdGVyZWRQcm9qZWN0cy5tYXAoKGl0ZW0pID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpc1BsYXlpbmdQcmV2aWV3ID0gcHJldmlld1BsYXlpbmdJZCA9PT0gaXRlbS5pZDtcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgICAgICAgICAgICAgPHRyXG4gICAgICAgICAgICAgICAgICAgICAgICAgIGtleT17aXRlbS5pZH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9e2Bwcm9qZWN0LWNhcmQtJHtpdGVtLmlkfWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IG9uT3BlblByb2plY3QoaXRlbS5pZCl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtMTIgaG92ZXI6YmctW3ZhcigtLWF2cC1ob3ZlcildIHRyYW5zaXRpb24tY29sb3JzIGN1cnNvci1wb2ludGVyXCJcbiAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzTmFtZT1cInB4LTMgZm9udC1ib2xkIHRleHQtW3ZhcigtLWF2cC10ZXh0KV1cIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoZSkgPT4gaGFuZGxlVG9nZ2xlUXVpY2tQcmV2aWV3KGUsIGl0ZW0pfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJ3LTYgaC02IHJvdW5kZWQtW3ZhcigtLWF2cC1yYWRpdXMteHMpXSBiZy1bdmFyKC0tYXZwLXN1cmZhY2UtMildIGJvcmRlciBib3JkZXItW3ZhcigtLWF2cC1ib3JkZXIpXSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LVt2YXIoLS1hdnAtYnJhbmQpXSBob3ZlcjpiZy1bdmFyKC0tYXZwLWJyYW5kLXNvZnQpXSBjdXJzb3ItcG9pbnRlclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRpdGxlPXtpc0ZhID8gJ9m+24zYtOKAjNi02YbZiNivINiz2LHbjNi5JyA6ICdRdWljayBBdWRpdGlvbid9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtpc1BsYXlpbmdQcmV2aWV3ID8gKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxTcXVhcmUgY2xhc3NOYW1lPVwidy0yLjUgaC0yLjUgZmlsbC1jdXJyZW50XCIgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8UGxheSBjbGFzc05hbWU9XCJ3LTIuNSBoLTIuNSBmaWxsLWN1cnJlbnRcIiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzc05hbWU9XCJ0cnVuY2F0ZSBtYXgtdy1bMjQwcHhdXCI+e2l0ZW0ubmFtZX08L3NwYW4+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvdGQ+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDx0ZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInB4LTMgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gZm9udC1tb25vIHRleHQtWzExcHhdIGhpZGRlbiBzbTp0YWJsZS1jZWxsXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkaXI9XCJsdHJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge2l0ZW0uc291cmNlRmlsZU5hbWV9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvdGQ+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDx0ZCBjbGFzc05hbWU9XCJweC0zXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPHNwYW5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT17YGlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LVsxMHB4XSBmb250LW1lZGl1bSBweC0yIHB5LTAuNSByb3VuZGVkLWZ1bGwgYm9yZGVyICR7Z2V0U3RhdHVzQmFkZ2VDbGFzc2VzKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpdGVtLnN0YXR1cyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICl9YH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7Zm9ybWF0UHJvamVjdFN0YXR1c0xhYmVsKGl0ZW0uc3RhdHVzLCBsb2NhbGUpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPC90ZD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzTmFtZT1cInB4LTMgZm9udC1tb25vIGZvbnQtc2VtaWJvbGRcIiBkaXI9XCJsdHJcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7Zm9ybWF0QXVkaW9EdXJhdGlvbkNsb2NrKGl0ZW0uZHVyYXRpb25TZWMpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L3RkPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8dGQgY2xhc3NOYW1lPVwicHgtMyB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBoaWRkZW4gbWQ6dGFibGUtY2VsbFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtpdGVtLndvcmRDb3VudH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPC90ZD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPHRkIGNsYXNzTmFtZT1cInB4LTMgdGV4dC1bdmFyKC0tYXZwLXRleHQtbXV0ZWQpXSBoaWRkZW4gbGc6dGFibGUtY2VsbFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtmb3JtYXRSZWxhdGl2ZU1vZGlmaWVkVGltZShpdGVtLnVwZGF0ZWRBdE1zLCBsb2NhbGUpfVxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L3RkPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8dGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJweC0zIHRleHQtZW5kXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoZSkgPT4gZS5zdG9wUHJvcGFnYXRpb24oKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjVcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxidXR0b25cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IG9uT3BlblByb2plY3QoaXRlbS5pZCl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtNyBweC0yLjUgcm91bmRlZC1bdmFyKC0tYXZwLXJhZGl1cy1zbSldIGJnLVt2YXIoLS1hdnAtYnJhbmQtc29mdCldIHRleHQtW3ZhcigtLWF2cC1icmFuZCldIHRleHQtWzExcHhdIGZvbnQtc2VtaWJvbGQgY3Vyc29yLXBvaW50ZXJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7aXNGYSA/ICfZiNix2YjYryDYqNmHINin2LPYqtmI2K/bjNmIJyA6ICdPcGVuJ31cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlPVwiYnV0dG9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGF0YS10ZXN0aWQ9e2Bwcm9qZWN0LW1lbnUtYnRuLSR7aXRlbS5pZH1gfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXsoKSA9PiBzZXRDb25maXJtRGVsZXRlSXRlbShpdGVtKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwidy03IGgtNyByb3VuZGVkLVt2YXIoLS1hdnAtcmFkaXVzLXNtKV0gdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gaG92ZXI6dGV4dC1bdmFyKC0tYXZwLWVycm9yKV0gaG92ZXI6YmctW3ZhcigtLWF2cC1lcnJvcildLzEwIGlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBjdXJzb3ItcG9pbnRlclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUcmFzaDIgY2xhc3NOYW1lPVwidy0zLjUgaC0zLjVcIiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvdGQ+XG4gICAgICAgICAgICAgICAgICAgICAgICA8L3RyPlxuICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0pfVxuICAgICAgICAgICAgICAgICAgPC90Ym9keT5cbiAgICAgICAgICAgICAgICA8L3RhYmxlPlxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICl9XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICl9XG4gICAgICA8L21haW4+XG5cbiAgICAgIHsvKiBEZWxldGUgUHJvamVjdCBDb25maXJtYXRpb24gRGlhbG9nICovfVxuICAgICAge2NvbmZpcm1EZWxldGVJdGVtICYmIChcbiAgICAgICAgPGRpdlxuICAgICAgICAgIGNsYXNzTmFtZT1cImZpeGVkIGluc2V0LTAgei01MCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay81MCBiYWNrZHJvcC1ibHVyLVsycHhdIHAtNFwiXG4gICAgICAgICAgcm9sZT1cImRpYWxvZ1wiXG4gICAgICAgICAgYXJpYS1tb2RhbD1cInRydWVcIlxuICAgICAgICAgIGRhdGEtdGVzdGlkPVwiY29uZmlybS1kZWxldGUtcHJvamVjdC1tb2RhbFwiXG4gICAgICAgICAgb25DbGljaz17KCkgPT4gc2V0Q29uZmlybURlbGV0ZUl0ZW0obnVsbCl9XG4gICAgICAgID5cbiAgICAgICAgICA8ZGl2XG4gICAgICAgICAgICBjbGFzc05hbWU9XCJ3LWZ1bGwgbWF4LXctbWQgcm91bmRlZC0yeGwgYm9yZGVyIGJvcmRlci1bdmFyKC0tYXZwLWJvcmRlcildIGJnLVt2YXIoLS1hdnAtc3VyZmFjZSldIHAtNSBzaGFkb3ctW3ZhcigtLWF2cC1zaGFkb3ctbWQpXSBzcGFjZS15LTRcIlxuICAgICAgICAgICAgb25DbGljaz17KGUpID0+IGUuc3RvcFByb3BhZ2F0aW9uKCl9XG4gICAgICAgICAgPlxuICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLXN0YXJ0IGdhcC0zXCI+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwidy0xMCBoLTEwIHJvdW5kZWQteGwgYmctW3ZhcigtLWF2cC1lcnJvcildLzE1IHRleHQtW3ZhcigtLWF2cC1lcnJvcildIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHNocmluay0wXCI+XG4gICAgICAgICAgICAgICAgPFRyYXNoMiBjbGFzc05hbWU9XCJ3LTUgaC01XCIgLz5cbiAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwic3BhY2UteS0xXCI+XG4gICAgICAgICAgICAgICAgPGgzIGNsYXNzTmFtZT1cInRleHQtYmFzZSBmb250LWJvbGQgdGV4dC1bdmFyKC0tYXZwLXRleHQpXVwiPlxuICAgICAgICAgICAgICAgICAge2lzRmEgPyAn2K3YsNmBINm+2LHZiNqY2YfYnycgOiAnRGVsZXRlIFByb2plY3Q/J31cbiAgICAgICAgICAgICAgICA8L2gzPlxuICAgICAgICAgICAgICAgIDxwIGNsYXNzTmFtZT1cInRleHQteHMgdGV4dC1bdmFyKC0tYXZwLXRleHQtc2Vjb25kYXJ5KV0gbGVhZGluZy1yZWxheGVkXCI+XG4gICAgICAgICAgICAgICAgICB7aXNGYVxuICAgICAgICAgICAgICAgICAgICA/IGDYotuM2Kcg2KfYsiDYrdiw2YEg2b7YsdmI2pjZhyDCqyR7Y29uZmlybURlbGV0ZUl0ZW0ubmFtZX3CuyDZhdi32YXYptmGINmH2LPYqtuM2K/YnyDYp9uM2YYg2LnZhdmEINmC2KfYqNmEINio2KfYstqv2LTYqiDZhtuM2LPYqi5gXG4gICAgICAgICAgICAgICAgICAgIDogYEFyZSB5b3Ugc3VyZSB5b3Ugd2FudCB0byBkZWxldGUgXCIke2NvbmZpcm1EZWxldGVJdGVtLm5hbWV9XCI/IFRoaXMgYWN0aW9uIGNhbm5vdCBiZSB1bmRvbmUuYH1cbiAgICAgICAgICAgICAgICA8L3A+XG4gICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTIgcHQtMlwiPlxuICAgICAgICAgICAgICA8YnV0dG9uXG4gICAgICAgICAgICAgICAgdHlwZT1cImJ1dHRvblwiXG4gICAgICAgICAgICAgICAgb25DbGljaz17KCkgPT4gc2V0Q29uZmlybURlbGV0ZUl0ZW0obnVsbCl9XG4gICAgICAgICAgICAgICAgZGlzYWJsZWQ9e2lzRGVsZXRpbmd9XG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiaC05IHB4LTQgcm91bmRlZC14bCBib3JkZXIgYm9yZGVyLVt2YXIoLS1hdnAtYm9yZGVyKV0gdGV4dC14cyBmb250LW1lZGl1bSB0ZXh0LVt2YXIoLS1hdnAtdGV4dC1zZWNvbmRhcnkpXSBob3ZlcjpiZy1bdmFyKC0tYXZwLWhvdmVyKV0gY3Vyc29yLXBvaW50ZXJcIlxuICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAge2lzRmEgPyAn2KfZhti12LHYp9mBJyA6ICdDYW5jZWwnfVxuICAgICAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgPGJ1dHRvblxuICAgICAgICAgICAgICAgIHR5cGU9XCJidXR0b25cIlxuICAgICAgICAgICAgICAgIGRhdGEtdGVzdGlkPVwiYnRuLWNvbmZpcm0tZGVsZXRlLXByb2plY3RcIlxuICAgICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHZvaWQgaGFuZGxlQ29uZmlybURlbGV0ZSgpfVxuICAgICAgICAgICAgICAgIGRpc2FibGVkPXtpc0RlbGV0aW5nfVxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImgtOSBweC00IHJvdW5kZWQteGwgYmctW3ZhcigtLWF2cC1lcnJvcildIHRleHQtd2hpdGUgdGV4dC14cyBmb250LXNlbWlib2xkIGhvdmVyOm9wYWNpdHktOTAgY3Vyc29yLXBvaW50ZXJcIlxuICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAge2lzRGVsZXRpbmdcbiAgICAgICAgICAgICAgICAgID8gaXNGYVxuICAgICAgICAgICAgICAgICAgICA/ICfYr9ixINit2KfZhCDYrdiw2YEuLi4nXG4gICAgICAgICAgICAgICAgICAgIDogJ0RlbGV0aW5nLi4uJ1xuICAgICAgICAgICAgICAgICAgOiBpc0ZhXG4gICAgICAgICAgICAgICAgICAgID8gJ9it2LDZgSDZvtix2YjamNmHJ1xuICAgICAgICAgICAgICAgICAgICA6ICdEZWxldGUgUHJvamVjdCd9XG4gICAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgKX1cbiAgICA8L2Rpdj5cbiAgKTtcbn07XG4iXX0=