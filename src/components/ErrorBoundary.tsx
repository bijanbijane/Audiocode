import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import {
  buildUserFacingFailure,
  classifyError,
  getSharedDiagnosticLogger,
} from '../reliability';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  locale?: 'fa' | 'en';
  onResetWorkspace?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  classified: ReturnType<typeof classifyError> | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, classified: null };
  }

  public static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const classified = classifyError(error, {
      subsystem: 'INTERNAL',
    });
    return { hasError: true, classified };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const classified = classifyError(error, {
      subsystem: 'INTERNAL',
    });
    getSharedDiagnosticLogger().log({
      severity: 'CRITICAL',
      subsystem: 'INTERNAL',
      code: classified.code,
      message: classified.message,
      metadata: {
        componentStackLength: info.componentStack?.length ?? 0,
      },
    });
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, classified: null });
    this.props.onResetWorkspace?.();
  };

  public render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const locale = this.props.locale ?? 'fa';
    const failure = this.state.classified
      ? buildUserFacingFailure(this.state.classified, locale)
      : null;
    const isFa = locale === 'fa';

    return (
      <div
        role="alert"
        dir={isFa ? 'rtl' : 'ltr'}
        className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100 p-6"
      >
        <div className="w-full max-w-lg rounded-lg border border-rose-500/40 bg-white dark:bg-[#131924] p-6 space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-1">
              <h1 className="text-base font-bold">
                {failure?.title ??
                  (isFa
                    ? 'خطای غیرمنتظره در رابط کاربری'
                    : 'Unexpected User Interface Error')}
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                {failure?.explanation ??
                  (isFa
                    ? 'بخشی از محیط کار دچار خطا شد. فایل صوتی و پروژه اصلی شما تغییر نکرده است.'
                    : 'A workspace view encountered an error. Your original audio and project remain untouched.')}
              </p>
            </div>
          </div>

          {failure && (
            <div className="rounded border border-slate-200 dark:border-[#252F42] bg-slate-50 dark:bg-[#0E131D] px-3.5 py-2.5 text-xs space-y-1">
              <div className="font-medium text-emerald-700 dark:text-emerald-300">
                {failure.originalDataStatus}
              </div>
              <div className="text-slate-500 dark:text-slate-400 font-mono" dir="ltr">
                {failure.code}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={this.handleReset}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md bg-amber-400 text-slate-950 hover:bg-amber-300 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isFa ? 'بازیابی ایمن محیط کار' : 'Safely Restore Workspace'}</span>
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-xs font-medium rounded-md border border-slate-300 dark:border-[#252F42] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1E2738] cursor-pointer"
            >
              {isFa ? 'بارگذاری مجدد صفحه' : 'Reload Page'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
