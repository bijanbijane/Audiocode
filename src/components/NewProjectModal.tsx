import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  FileAudio,
  Loader2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  AudioFileValidationResult,
  MAX_PROJECT_AUDIO_FILE_BYTES,
  deriveDefaultProjectNameFromFile,
  formatAudioByteSize,
  validateBrowserAudioFile,
} from '../projects/audioFileValidator';
import { validateProjectName } from '../projects/projectLibraryLogic';
import { AccessibleModal } from './AccessibleModal';

interface NewProjectModalProps {
  isOpen: boolean;
  locale: 'fa' | 'en';
  onClose: () => void;
  onCreateProject: (params: {
    name: string;
    file: File;
    detectedContainer: string;
  }) => Promise<void>;
}

export const NewProjectModal: React.FC<NewProjectModalProps> = ({
  isOpen,
  locale,
  onClose,
  onCreateProject,
}) => {
  const isFa = locale === 'fa';
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<AudioFileValidationResult | null>(null);
  const [projectName, setProjectName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetDialog = () => {
    setSelectedFile(null);
    setValidation(null);
    setProjectName('');
    setNameError(null);
    setSubmitError(null);
    setIsDragging(false);
    setIsValidating(false);
    setIsSubmitting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    if (isSubmitting) return;
    resetDialog();
    onClose();
  };

  const inspectFile = async (file: File | null | undefined) => {
    if (!file) return;
    setSubmitError(null);
    setNameError(null);
    setIsValidating(true);
    setSelectedFile(file);
    try {
      const res = await validateBrowserAudioFile(file, MAX_PROJECT_AUDIO_FILE_BYTES);
      setValidation(res);
      if (res.valid) {
        setProjectName((prev) =>
          prev.trim().length > 0 ? prev : deriveDefaultProjectNameFromFile(file.name),
        );
      }
    } finally {
      setIsValidating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || isValidating) return;
    if (!selectedFile || !validation?.valid || !validation.container) return;

    const nameCheck = validateProjectName(projectName);
    if (!nameCheck.valid) {
      setNameError(isFa ? (nameCheck.errorFa ?? 'نام نامعتبر') : (nameCheck.errorEn ?? 'Invalid name'));
      return;
    }

    setNameError(null);
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onCreateProject({
        name: nameCheck.trimmed,
        file: selectedFile,
        detectedContainer: validation.container,
      });
      resetDialog();
      onClose();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : isFa
            ? 'ساخت پروژه با خطا مواجه شد. لطفاً دوباره تلاش کنید.'
            : 'Project creation failed. Please try again.';
      setSubmitError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const canCreate = Boolean(
    selectedFile &&
      validation?.valid &&
      projectName.trim().length > 0 &&
      !isValidating &&
      !isSubmitting,
  );

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={handleClose}
      closeOnBackdropClick={!isSubmitting}
      dir={isFa ? 'rtl' : 'ltr'}
      labelledBy="new-project-modal-title"
      disableEscape={isSubmitting}
      dataTestId="new-project-modal"
      panelClassName="w-full max-w-lg rounded-2xl border border-[var(--avp-border)] bg-[var(--avp-surface)] text-[var(--avp-text)] shadow-[var(--avp-shadow-md)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--avp-border)]">
        <div>
          <h2 id="new-project-modal-title" className="text-base font-bold">
            {isFa ? 'ساخت پروژه جدید' : 'Create New Project'}
          </h2>
          <p className="text-xs text-[var(--avp-text-secondary)] mt-0.5">
            {isFa
              ? 'فایل صوتی خود را وارد کنید تا پردازش محلی در استودیو آغاز شود.'
              : 'Import an audio file to begin local speech editing in Studio.'}
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          disabled={isSubmitting}
          aria-label={isFa ? 'بستن پنجره' : 'Close dialog'}
          className="avp-btn-icon avp-touch-icon"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Dropzone / File Picker */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.webm"
              data-testid="new-project-file-input"
              onChange={(e) => {
                void inspectFile(e.target.files?.[0]);
              }}
              className="hidden"
            />
            {selectedFile && validation?.valid ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!isSubmitting) setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (!isSubmitting) {
                    void inspectFile(e.dataTransfer.files?.[0]);
                  }
                }}
                className={`rounded-xl border-2 border-dashed p-5 transition-colors ${
                  isDragging
                    ? 'border-[var(--avp-brand)] bg-[var(--avp-brand-soft)]'
                    : 'border-[var(--avp-brand)]/60 bg-[var(--avp-surface-2)]/60'
                }`}
              >
                <div className="flex items-center justify-between gap-3 text-start">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[var(--avp-brand-soft)] text-[var(--avp-brand)] flex items-center justify-center shrink-0">
                      <FileAudio className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate" dir="auto">
                        {selectedFile.name}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-[var(--avp-text-secondary)] mt-0.5">
                        <span className="inline-flex items-center gap-1 text-[var(--avp-brand)] font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                          {validation.container}
                        </span>
                        <span>·</span>
                        <span className="tabular-nums">{formatAudioByteSize(selectedFile.size, locale)}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => {
                      setSelectedFile(null);
                      setValidation(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[32px] shrink-0"
                  >
                    {isFa ? 'تغییر فایل' : 'Replace'}
                  </button>
                </div>
              </div>
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!isSubmitting) setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragging(false);
                  if (!isSubmitting) {
                    void inspectFile(e.dataTransfer.files?.[0]);
                  }
                }}
                onClick={() => {
                  if (!isSubmitting) fileInputRef.current?.click();
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !isSubmitting) {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
                  isDragging
                    ? 'border-[var(--avp-brand)] bg-[var(--avp-brand-soft)]'
                    : validation && !validation.valid
                      ? 'border-[var(--avp-error)] bg-[var(--avp-error-soft)]/50'
                      : 'border-[var(--avp-border-strong)] bg-[var(--avp-bg)] hover:border-[var(--avp-brand)]/60 hover:bg-[var(--avp-hover)]/40'
                }`}
              >
                {isValidating ? (
                  <div className="flex flex-col items-center gap-2 py-2">
                    <Loader2 className="w-6 h-6 animate-spin text-[var(--avp-brand)]" aria-hidden="true" />
                    <p className="text-xs text-[var(--avp-text-secondary)]">
                      {isFa ? 'در حال بررسی امضای باینری فایل صوتی...' : 'Inspecting binary audio signature...'}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-11 h-11 rounded-xl bg-[var(--avp-surface-2)] text-[var(--avp-brand)] flex items-center justify-center">
                      <UploadCloud className="w-5 h-5" aria-hidden="true" />
                    </div>
                    <p className="text-sm font-medium text-[var(--avp-text)]">
                      {isFa
                        ? 'فایل صوتی خود را اینجا رها کنید یا انتخاب کنید'
                        : 'Drop your audio file here or click to browse'}
                    </p>
                    <p className="text-xs text-[var(--avp-text-muted)]">
                      {isFa
                        ? 'فرمت‌های مجاز: WAV، MP3، FLAC، OGG، M4A، WebM (حداکثر ۲۵۶ مگابایت)'
                        : 'Supported: WAV, MP3, FLAC, OGG, M4A, WebM (max 256 MB)'}
                    </p>
                  </div>
                )}
              </div>
            )}

            {validation && !validation.valid && (
              <div
                role="alert"
                data-testid="new-project-file-error"
                className="mt-2.5 flex items-start gap-2 rounded-xl border border-[var(--avp-error)]/40 bg-[var(--avp-error-soft)] px-3.5 py-2.5 text-xs text-[var(--avp-error)]"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{isFa ? validation.errorFa : validation.errorEn}</span>
              </div>
            )}
          </div>

          {/* Project Name */}
          <div className="space-y-1.5">
            <label
              htmlFor="new-project-name-input"
              className="block text-xs font-semibold text-[var(--avp-text)]"
            >
              {isFa ? 'نام پروژه' : 'Project Name'}
            </label>
            <input
              id="new-project-name-input"
              data-testid="new-project-name-input"
              type="text"
              value={projectName}
              onChange={(e) => {
                setProjectName(e.target.value);
                if (nameError) setNameError(null);
              }}
              disabled={isSubmitting}
              maxLength={100}
              placeholder={isFa ? 'مثلاً: اپیزود ۱۴ پادکست فناوری' : 'e.g., Tech Podcast Episode 14'}
              className="avp-input w-full min-h-[44px] sm:min-h-[38px] px-3.5 text-sm disabled:opacity-50"
            />
            {nameError && (
              <p className="text-xs text-[var(--avp-error)]" role="alert">
                {nameError}
              </p>
            )}
          </div>

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-[var(--avp-error)]/40 bg-[var(--avp-error-soft)] px-3.5 py-2.5 text-xs text-[var(--avp-error)]"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[var(--avp-border)]">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="avp-btn avp-btn-outline min-h-[44px] sm:min-h-[36px] px-4"
            >
              {isFa ? 'انصراف' : 'Cancel'}
            </button>
            <button
              type="submit"
              data-testid="btn-confirm-create-project"
              disabled={!canCreate}
              className="avp-btn avp-btn-primary min-h-[44px] sm:min-h-[36px] px-5"
            >
              {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
              <span>
                {isSubmitting
                  ? isFa
                    ? 'در حال پردازش و ذخیره محلی...'
                    : 'Importing & saving locally...'
                  : isFa
                    ? 'ایجاد پروژه'
                    : 'Create Project'}
              </span>
            </button>
          </div>
        </form>
    </AccessibleModal>
  );
};
