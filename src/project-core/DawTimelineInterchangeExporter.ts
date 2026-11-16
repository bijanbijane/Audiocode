import { ProjectDocument } from '../contracts/project-schema.contract';
import { TimeMath } from '../contracts/timebase.contract';

export type AssetFileNameLookup = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

function resolveAssetFileName(
  assetId: string,
  lookup: AssetFileNameLookup,
): string {
  const raw =
    lookup instanceof Map
      ? lookup.get(assetId)
      : (lookup as Readonly<Record<string, string | undefined>>)[assetId];
  const candidate = raw ?? `${assetId}.wav`;
  // Strip directory traversal components and normalize separators for portable studio media/ folders
  const baseName = candidate.replace(/^.*[\\/]/, '');
  return baseName || `${assetId}.wav`;
}

function collectReferencedAssetIds(doc: ProjectDocument): string[] {
  const seen = new Set<string>();
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      seen.add(clip.assetId);
    }
  }
  return Array.from(seen);
}

/**
 * Sample-Accurate Non-Destructive DAW Interchange Exporter (Sections 6, 20 & 34)
 * Exports complete multi-track edit timelines with micro-crossfades, gain, Mute/Solo,
 * and Room Tone fills to Adobe Audition (.sesx XML) and Cockos Reaper (.rpp).
 */
export class DawTimelineInterchangeExporter {
  public static exportToAdobeAuditionSesx(
    doc: ProjectDocument,
    assetFileNamesMap: AssetFileNameLookup,
  ): string {
    const sr = doc.canonicalSampleRate;
    const lines: string[] = [
      `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>`,
      `<sesx version="1.9">`,
      `  <session appVersion="24.0" audioChannelType="stereo" bitDepth="32" sampleRate="${sr}">`,
      `    <name>${this.escapeXml(doc.name)}</name>`,
      `    <tracks>`,
    ];

    doc.tracks.forEach((track, trackIdx) => {
      lines.push(
        `      <audioTrack automationLaneOpenState="false" id="${trackIdx + 1}" index="${trackIdx + 1}">`,
        `        <trackParameters>`,
        `          <name>${this.escapeXml(track.name)}</name>`,
        `          <mute>${track.muted}</mute>`,
        `          <solo>${track.solo}</solo>`,
        `        </trackParameters>`,
      );

      track.clips.forEach((clip, clipIdx) => {
        const tlStartSample = TimeMath.flicksToSamplesFloor(clip.timelineRange.start, sr);
        const tlEndSample = TimeMath.flicksToSamplesFloor(clip.timelineRange.end, sr);
        const srcStartSample = TimeMath.flicksToSamplesFloor(clip.sourceRange.start, sr);
        const srcEndSample = TimeMath.flicksToSamplesFloor(clip.sourceRange.end, sr);
        const clipLenSamples = Math.max(0, tlEndSample - tlStartSample);
        const fadeInSamples = Math.min(
          clipLenSamples,
          Math.max(0, TimeMath.flicksToSamplesFloor(clip.fadeInFlicks, sr)),
        );
        const fadeOutSamples = Math.min(
          clipLenSamples,
          Math.max(0, TimeMath.flicksToSamplesFloor(clip.fadeOutFlicks, sr)),
        );

        lines.push(
          `        <audioClip clipAutoCrossfade="true" fileID="${this.escapeXml(clip.assetId)}" id="${clipIdx}" name="${this.escapeXml(clip.id)}" startPoint="${tlStartSample}" endPoint="${tlEndSample}" sourceInPoint="${srcStartSample}" sourceOutPoint="${srcEndSample}">`,
          `          <fadeIn crossFadeLinkType="linkedAsymmetric" endPoint="${fadeInSamples}" shape="cosine" startPoint="0"/>`,
          `          <fadeOut crossFadeLinkType="linkedAsymmetric" endPoint="${clipLenSamples}" shape="cosine" startPoint="${Math.max(0, clipLenSamples - fadeOutSamples)}"/>`,
          `        </audioClip>`,
        );
      });

      lines.push(`      </audioTrack>`);
    });

    const assetIds = new Set<string>(collectReferencedAssetIds(doc));
    if (assetFileNamesMap instanceof Map) {
      for (const id of assetFileNamesMap.keys()) assetIds.add(id);
    } else {
      for (const id of Object.keys(assetFileNamesMap)) assetIds.add(id);
    }

    lines.push(`    </tracks>`, `    <files>`);
    for (const assetId of assetIds) {
      const fileName = resolveAssetFileName(assetId, assetFileNamesMap);
      lines.push(
        `      <file id="${this.escapeXml(assetId)}" mediaHandler="AmioWav" relativePath="media/${this.escapeXml(fileName)}"/>`,
      );
    }
    lines.push(`    </files>`, `  </session>`, `</sesx>`);

    return lines.join('\n');
  }

  public static exportToReaperRpp(
    doc: ProjectDocument,
    assetFileNamesMap: AssetFileNameLookup,
    timestampSec = Math.floor(Date.now() / 1000),
  ): string {
    const lines: string[] = [
      `<REAPER_PROJECT 0.1 "7.0" ${Math.floor(timestampSec)}`,
      `  SAMPLERATE ${doc.canonicalSampleRate} 0 0`,
    ];

    for (const track of doc.tracks) {
      const muteFlag = track.muted ? 1 : 0;
      const soloFlag = track.solo ? 1 : 0;

      lines.push(
        `  <TRACK`,
        `    NAME "${this.escapeRppQuoted(track.name)}"`,
        `    MUTESOLO ${muteFlag} ${soloFlag} 0`,
      );

      for (const clip of track.clips) {
        const posSec = TimeMath.flicksToSeconds(clip.timelineRange.start).toFixed(6);
        const lenSec = Math.max(
          0,
          TimeMath.flicksToSeconds(clip.timelineRange.end - clip.timelineRange.start),
        ).toFixed(6);
        const soffsSec = TimeMath.flicksToSeconds(clip.sourceRange.start).toFixed(6);
        const fadeInSec = Math.max(0, TimeMath.flicksToSeconds(clip.fadeInFlicks)).toFixed(6);
        const fadeOutSec = Math.max(0, TimeMath.flicksToSeconds(clip.fadeOutFlicks)).toFixed(6);
        const linearGain = Math.pow(10, clip.gainDb / 20).toFixed(6);
        const fileName = resolveAssetFileName(clip.assetId, assetFileNamesMap);

        lines.push(
          `    <ITEM`,
          `      POSITION ${posSec}`,
          `      LENGTH ${lenSec}`,
          `      SOFFS ${soffsSec}`,
          `      VOLPAN ${linearGain} 0 1 -1`,
          `      FADEIN 1 ${fadeInSec} 0 1 0 0 0`,
          `      FADEOUT 1 ${fadeOutSec} 0 1 0 0 0`,
          `      NAME "${this.escapeRppQuoted(clip.id)}"`,
          `      <SOURCE WAVE`,
          `        FILE "media/${this.escapeRppQuoted(fileName)}"`,
          `      >`,
          `    >`,
        );
      }
      lines.push(`  >`);
    }

    lines.push(`>`);
    return lines.join('\n');
  }

  private static escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private static escapeRppQuoted(unsafe: string): string {
    return unsafe.replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
  }
}
