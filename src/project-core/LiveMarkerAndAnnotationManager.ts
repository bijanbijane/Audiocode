import { Flicks, TimeMath, TimeRange } from '../contracts/timebase.contract';

export type MarkerCategory =
  | 'EDIT_MISTAKE_FLAG' // علامت‌گذاری تپق یا اشتباه گوینده در حین ضبط زنده
  | 'FACT_CHECK_NOTE' // نیازمند بررسی صحت علمی/تاریخی مطلب
  | 'HIGHLIGHT_QUOTE' // جمله طلایی برای تیزر یا استوری
  | 'CHAPTER_BOUNDARY'; // شروع مبحث جدید

export interface TimelineAnnotationMarker {
  readonly markerId: string;
  readonly category: MarkerCategory;
  readonly noteFa: string;
  /** موقعیت زمانی روی تایم‌لاین فعلی (که با برش‌های Ripple جابه‌جا می‌شود) */
  readonly timelineFlicks: Flicks;
  /** موقعیت تغییرناپذیر داخل فایل اصلی خام (برای ردیابی همیشگی به مبدأ) */
  readonly originalSourceFlicks: Flicks;
  readonly createdAtMs: number;
}

export class LiveMarkerAndAnnotationManager {
  private markers: TimelineAnnotationMarker[] = [];

  /**
   * ۱. ثبت نشانگر زنده در حین ضبط یا پخش (کلید M) با جبران خودکار تأخیر واکنش مغز و دست انسان!
   * وقتی گوینده تپق می‌زند و تهیه‌کننده دکمه M را فشار می‌دهد، حدود 550ms از لحظه تپق گذشته است.
   */
  public addLiveMarkerWithReactionCompensation(params: {
    rawTriggerFlicks: Flicks;
    category: MarkerCategory;
    noteFa: string;
    humanReactionLookbackMs?: number; // پیش‌فرض ۵۵۰ میلی‌ثانیه جبران زمان واکنش انسان
  }): TimelineAnnotationMarker {
    const lookbackFlicks = TimeMath.secondsToFlicks(
      (params.humanReactionLookbackMs ?? 550) / 1000,
    );
    const compensatedFlicks = Math.max(0, params.rawTriggerFlicks - lookbackFlicks);

    const marker: TimelineAnnotationMarker = {
      markerId: `mk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      category: params.category,
      noteFa: params.noteFa,
      timelineFlicks: compensatedFlicks,
      originalSourceFlicks: compensatedFlicks,
      createdAtMs: Date.now(),
    };

    this.markers.push(marker);
    this.markers.sort((a, b) => a.timelineFlicks - b.timelineFlicks);
    return marker;
  }

  /**
   * ۲. به‌روزرسانی خودکار موقعیت تمام نشانگرها پس از انجام یک برش Ripple در تایم‌لاین
   */
  public applyRippleCutToMarkers(
    deletedTimelineRange: TimeRange,
    injectedRoomToneFlicks: Flicks = 0,
  ): TimelineAnnotationMarker[] {
    const netShiftLeft =
      deletedTimelineRange.end - deletedTimelineRange.start - injectedRoomToneFlicks;

    this.markers = this.markers
      // حذف نشانگرهایی که دقیقاً داخل بازه حذف‌شده قرار داشته‌اند
      .filter(
        (m) =>
          m.timelineFlicks < deletedTimelineRange.start ||
          m.timelineFlicks >= deletedTimelineRange.end,
      )
      .map((m) => {
        if (m.timelineFlicks >= deletedTimelineRange.end) {
          return {
            ...m,
            timelineFlicks: Math.max(
              deletedTimelineRange.start,
              m.timelineFlicks - netShiftLeft,
            ),
          };
        }
        return m;
      });

    return [...this.markers];
  }

  public getMarkers(): readonly TimelineAnnotationMarker[] {
    return this.markers;
  }
}
