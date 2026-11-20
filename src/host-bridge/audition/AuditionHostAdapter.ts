/**
 * AVAPARDAZ — ADOBE AUDITION HOST ADAPTER & SESX INTERCHANGE VALIDATOR
 *
 * Compliant with AVP-ARCH-001 (Version 4.0) Sections 8.2, 9.1–9.4, 16.2–16.3:
 * - Strictly isolated inside `/src/host-bridge/audition/` (NEVER imported by Processing Core).
 * - Treats SESX strictly as a host interchange representation, NEVER as the internal domain model.
 * - Explicitly classifies verified vs unverified Adobe Audition host capability levels without
 *   falsely claiming desktop Audition execution inside a headless Linux container.
 */

import type { CanonicalProject } from '../CanonicalProjectService';

export const AUDITION_HOST_ADAPTER_VERSION = '1.0.0' as const;

export type HostCapabilityLevel =
  | 'CONTEXT_ACCESS'
  | 'ANALYSIS_INTEGRATION'
  | 'INTERCHANGE_INTEGRATION'
  | 'PROJECT_MODIFICATION'
  | 'INTERACTIVE_SYNCHRONIZATION'
  | 'REAL_TIME_AUDIO_INTEGRATION';

export type HostVerificationState =
  | 'VERIFIED_CONTRACT_AND_SCHEMA'
  | 'UNVERIFIED_REQUIRES_AUDITION_HOST';

export interface AuditionHostCapabilityEntry {
  readonly feature_id: string;
  readonly required_host_operation: string;
  readonly integration_mechanism: string;
  readonly minimum_target_audition_version: string;
  readonly target_operating_systems: readonly ('macOS' | 'Windows')[];
  readonly host_adapter_version: string;
  readonly capability_level: HostCapabilityLevel;
  readonly verification_state: HostVerificationState;
  readonly known_limitations: readonly string[];
  readonly fallback_workflow: string;
}

export interface SesxValidationIssue {
  readonly severity: 'ERROR' | 'WARNING';
  readonly code: string;
  readonly message: string;
}

export interface SesxValidationReport {
  readonly valid_xml_structure: boolean;
  readonly valid_sesx_semantics: boolean;
  readonly verified_in_desktop_audition: false;
  readonly verification_disclaimer: string;
  readonly detected_sample_rate_hz: number | null;
  readonly track_count: number;
  readonly clip_count: number;
  readonly media_file_count: number;
  readonly issues: readonly SesxValidationIssue[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class AdobeAuditionHostAdapter {
  public readonly hostId = 'adobe-audition' as const;
  public readonly adapterVersion = AUDITION_HOST_ADAPTER_VERSION;

  /**
   * Honest Host Capability Matrix (AVP-ARCH-001 Section 9.2 & 16.3).
   */
  public getHostCapabilityMatrix(): readonly AuditionHostCapabilityEntry[] {
    return Object.freeze([
      Object.freeze({
        feature_id: 'audition.context.active_document_metadata',
        required_host_operation: 'Read active session/document metadata and selection bounds',
        integration_mechanism: 'CEP Panel + ExtendScript Host Bridge + Companion IPC v1.0.0',
        minimum_target_audition_version: '24.0',
        target_operating_systems: ['macOS', 'Windows'] as const,
        host_adapter_version: this.adapterVersion,
        capability_level: 'CONTEXT_ACCESS' as const,
        verification_state: 'UNVERIFIED_REQUIRES_AUDITION_HOST' as const,
        known_limitations: [
          'Cannot be verified inside headless Linux container; requires macOS/Windows Adobe Audition runtime.',
        ],
        fallback_workflow: 'Import audio file or .sesx session file directly into Companion IPC / Web preview.',
      }),
      Object.freeze({
        feature_id: 'audition.analysis.local_processing_dispatch',
        required_host_operation: 'Dispatch active media to Local Processing Core via versioned Companion IPC',
        integration_mechanism: 'Local Loopback HMAC IPC (/api/v2/companion/ipc) -> Canonical Capability Registry',
        minimum_target_audition_version: '24.0',
        target_operating_systems: ['macOS', 'Windows'] as const,
        host_adapter_version: this.adapterVersion,
        capability_level: 'ANALYSIS_INTEGRATION' as const,
        verification_state: 'VERIFIED_CONTRACT_AND_SCHEMA' as const,
        known_limitations: [
          'Processing Core & Companion IPC verified on Linux Node.js; CEP panel host launch requires desktop Audition.',
        ],
        fallback_workflow: 'Run Local batch/long-form analysis via Companion HTTP loopback bridge.',
      }),
      Object.freeze({
        feature_id: 'audition.interchange.sesx_export_and_validate',
        required_host_operation: 'Generate and validate non-destructive Multitrack .sesx XML session interchange',
        integration_mechanism: 'SESX v1.9 XML Exporter & Structural Validator',
        minimum_target_audition_version: '23.0',
        target_operating_systems: ['macOS', 'Windows'] as const,
        host_adapter_version: this.adapterVersion,
        capability_level: 'INTERCHANGE_INTEGRATION' as const,
        verification_state: 'VERIFIED_CONTRACT_AND_SCHEMA' as const,
        known_limitations: [
          'Section 9.3 compliance notice: valid XML structure and clip sample validation are verified, but live opening inside desktop Adobe Audition must still be tested on macOS/Windows.',
        ],
        fallback_workflow: 'Export validated .sesx alongside original untouched source WAV files.',
      }),
      Object.freeze({
        feature_id: 'audition.modification.direct_timeline_writeback',
        required_host_operation: 'Mutate active Multitrack clips directly inside open Audition session',
        integration_mechanism: 'ExtendScript / Audition App Commands (Subject to Host API Restrictions)',
        minimum_target_audition_version: '24.0',
        target_operating_systems: ['macOS', 'Windows'] as const,
        host_adapter_version: this.adapterVersion,
        capability_level: 'PROJECT_MODIFICATION' as const,
        verification_state: 'UNVERIFIED_REQUIRES_AUDITION_HOST' as const,
        known_limitations: [
          'Adobe Audition ExtendScript exposes restricted direct multitrack clip-split APIs compared to Premiere Pro.',
          'Never fabricate undocumented API hooks; fall back to validated non-destructive SESX interchange.',
        ],
        fallback_workflow: 'Generate approved non-destructive EditPlan and export validated .sesx interchange session.',
      }),
      Object.freeze({
        feature_id: 'audition.realtime.native_dsp_effect',
        required_host_operation: 'Real-time voice enhancement / HPF / noise-gate inside Audition Effects Rack',
        integration_mechanism: 'Optional Native VST3 / Audio Units Plug-in (Separate Component per Section 8.4)',
        minimum_target_audition_version: '23.0',
        target_operating_systems: ['macOS', 'Windows'] as const,
        host_adapter_version: this.adapterVersion,
        capability_level: 'REAL_TIME_AUDIO_INTEGRATION' as const,
        verification_state: 'UNVERIFIED_REQUIRES_AUDITION_HOST' as const,
        known_limitations: ['Native C++/Rust VST3/AU binary build requires desktop toolchain (Xcode/MSVC/Cargo).'],
        fallback_workflow: 'Offline non-destructive DSP preview & WAV render via Processing Core.',
      }),
    ]);
  }

  /**
   * Exports a host-neutral CanonicalProject into an Adobe Audition .sesx v1.9 interchange XML.
   * Never mutates the source project or source media.
   */
  public exportCanonicalProjectToSesx(project: CanonicalProject): {
    readonly sesx_xml: string;
    readonly validation: SesxValidationReport;
  } {
    const mediaEntries = Object.values(project.media);
    let maxSample: number = project.sample_rate_hz;
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.timeline_end_sample > maxSample) {
          maxSample = clip.timeline_end_sample;
        }
      }
    }

    const fileIdByMediaId = new Map<string, number>();
    const filesXml = mediaEntries
      .map((m, idx) => {
        const numericId = idx + 1;
        fileIdByMediaId.set(m.media_id, numericId);
        const absPath = escapeXml(m.storage_ref ?? `/media/${m.media_id}/${m.display_name}`);
        const relPath = escapeXml(`media/${m.display_name}`);
        return `    <file id="${numericId}" mediaId="${escapeXml(m.media_id)}" sha256="${escapeXml(m.sha256_hex)}" absolutePath="${absPath}" relativePath="${relPath}" sampleRate="${m.sample_rate_hz}" channels="${m.channel_count}" bitDepth="${m.bit_depth}" />`;
      })
      .join('\n');

    const tracksXml = project.tracks
      .map((track, tIdx) => {
        const clipsXml = track.clips
          .map((clip) => {
            const fileId = fileIdByMediaId.get(clip.media_id) ?? 0;
            return `        <audioClip id="${escapeXml(clip.clip_id)}" fileID="${fileId}" startPoint="${clip.timeline_start_sample}" endPoint="${clip.timeline_end_sample}" sourceInPoint="${clip.source_in_sample}" sourceOutPoint="${clip.source_in_sample + (clip.timeline_end_sample - clip.timeline_start_sample)}" muted="${clip.muted ? 'true' : 'false'}" gainDb="${clip.gain_db}" />`;
          })
          .join('\n');
        return [
          `      <audioTrack id="${tIdx + 1}" trackKey="${escapeXml(track.track_id)}" index="${tIdx + 1}" audioChannelType="${track.channel_count === 2 ? 'stereo' : 'mono'}">`,
          `        <trackParameters><name>${escapeXml(track.name)}</name></trackParameters>`,
          `        <trackAudioParameters muted="${track.muted ? 'true' : 'false'}" solo="${track.solo ? 'true' : 'false'}" gainDb="${track.gain_db}" />`,
          clipsXml,
          `      </audioTrack>`,
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n');

    const markersXml = project.markers
      .map(
        (m, idx) =>
          `      <cue id="${idx + 1}" markerId="${escapeXml(m.marker_id)}" name="${escapeXml(m.label)}" startPoint="${m.sample_position}" duration="${m.duration_samples}" kind="${escapeXml(m.kind)}" />`,
      )
      .join('\n');

    const xml = [
      `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>`,
      `<!DOCTYPE sesx>`,
      `<sesx version="1.9">`,
      `  <session appVersion="24.0" audioChannelType="stereo" bitDepth="32" duration="${maxSample}" sampleRate="${project.sample_rate_hz}" avapardazProjectId="${escapeXml(project.project_id)}" avapardazRevision="${project.revision}">`,
      `    <name>${escapeXml(project.name)}</name>`,
      `    <tracks>`,
      tracksXml,
      `    </tracks>`,
      `    <markers>`,
      markersXml,
      `    </markers>`,
      `  </session>`,
      `  <files>`,
      filesXml,
      `  </files>`,
      `</sesx>`,
    ].join('\n');

    const validation = this.validateSesxDocument(xml);
    return { sesx_xml: xml, validation };
  }

  /**
   * Validates SESX structure, sample-rate consistency, file references, and clip sample bounds (Section 9.3).
   */
  public validateSesxDocument(sesxXml: string): SesxValidationReport {
    const issues: SesxValidationIssue[] = [];
    const trimmed = typeof sesxXml === 'string' ? sesxXml.trim() : '';

    const hasSesxRoot = /<sesx\b[^>]*>/.test(trimmed) && /<\/sesx>\s*$/.test(trimmed);
    const hasSession = /<session\b[^>]*>/.test(trimmed) && /<\/session>/.test(trimmed);
    const hasFiles = /<files>[\s\S]*<\/files>/.test(trimmed);

    if (/<!ENTITY\b/i.test(trimmed)) {
      issues.push({
        severity: 'ERROR',
        code: 'SESX_FORBIDDEN_ENTITY_DECLARATION',
        message: 'XML ENTITY declarations are forbidden in SESX interchange documents.',
      });
    }
    if (!hasSesxRoot) {
      issues.push({
        severity: 'ERROR',
        code: 'SESX_MISSING_ROOT',
        message: 'Document must be wrapped in a <sesx>...</sesx> root element.',
      });
    }
    if (!hasSession) {
      issues.push({
        severity: 'ERROR',
        code: 'SESX_MISSING_SESSION',
        message: 'Missing required <session> block.',
      });
    }
    if (!hasFiles) {
      issues.push({
        severity: 'ERROR',
        code: 'SESX_MISSING_FILES',
        message: 'Missing required <files> media table.',
      });
    }

    const sessionRateMatch = trimmed.match(/<session\b[^>]*sampleRate="(\d+)"/);
    const sessionSampleRate = sessionRateMatch ? Number(sessionRateMatch[1]) : null;
    if (!sessionSampleRate || sessionSampleRate <= 0) {
      issues.push({
        severity: 'ERROR',
        code: 'SESX_INVALID_SAMPLE_RATE',
        message: 'Session must specify a positive integer sampleRate attribute.',
      });
    }

    // Parse registered <file> IDs and sample rates
    const fileSampleRates = new Map<string, number>();
    const fileRegex = /<file\b([^>]+)\/>/g;
    let fileMatch: RegExpExecArray | null;
    while ((fileMatch = fileRegex.exec(trimmed)) !== null) {
      const attrs = fileMatch[1];
      const idM = attrs.match(/\bid="([^"]+)"/);
      const rateM = attrs.match(/\bsampleRate="(\d+)"/);
      const absM = attrs.match(/\babsolutePath="([^"]+)"/);
      if (!idM) {
        issues.push({ severity: 'ERROR', code: 'SESX_FILE_MISSING_ID', message: 'A <file> entry is missing id.' });
        continue;
      }
      if (!absM || absM[1].trim().length === 0) {
        issues.push({
          severity: 'ERROR',
          code: 'SESX_FILE_MISSING_PATH',
          message: `File id="${idM[1]}" is missing absolutePath.`,
        });
      }
      const fRate = rateM ? Number(rateM[1]) : 0;
      fileSampleRates.set(idM[1], fRate);
      if (sessionSampleRate && fRate > 0 && fRate !== sessionSampleRate) {
        issues.push({
          severity: 'WARNING',
          code: 'SESX_SAMPLE_RATE_MISMATCH',
          message: `File id="${idM[1]}" sampleRate (${fRate}Hz) differs from session sampleRate (${sessionSampleRate}Hz); Audition will conform on import.`,
        });
      }
    }

    const trackMatches = trimmed.match(/<audioTrack\b/g) ?? [];
    const clipRegex = /<audioClip\b([^>]+)\/>/g;
    let clipMatch: RegExpExecArray | null;
    let clipCount = 0;
    while ((clipMatch = clipRegex.exec(trimmed)) !== null) {
      clipCount++;
      const attrs = clipMatch[1];
      const fileIdM = attrs.match(/\bfileID="([^"]+)"/);
      const startM = attrs.match(/\bstartPoint="(-?\d+)"/);
      const endM = attrs.match(/\bendPoint="(-?\d+)"/);

      if (!fileIdM || !fileSampleRates.has(fileIdM[1])) {
        issues.push({
          severity: 'ERROR',
          code: 'SESX_DANGLING_CLIP_FILE_REF',
          message: `Audio clip #${clipCount} references unknown fileID="${fileIdM?.[1] ?? 'missing'}".`,
        });
      }
      const startPt = startM ? Number(startM[1]) : -1;
      const endPt = endM ? Number(endM[1]) : -1;
      if (startPt < 0 || endPt <= startPt) {
        issues.push({
          severity: 'ERROR',
          code: 'SESX_INVALID_CLIP_BOUNDS',
          message: `Audio clip #${clipCount} has invalid sample bounds [${startPt}, ${endPt}).`,
        });
      }
    }

    const hasErrors = issues.some((i) => i.severity === 'ERROR');
    return Object.freeze({
      valid_xml_structure: hasSesxRoot && hasSession && hasFiles,
      valid_sesx_semantics: !hasErrors,
      verified_in_desktop_audition: false as const,
      verification_disclaimer:
        'AVP-ARCH-001 Section 9.3: Valid XML and semantic bounds verified; desktop Adobe Audition load verification requires a macOS/Windows Audition host.',
      detected_sample_rate_hz: sessionSampleRate,
      track_count: trackMatches.length,
      clip_count: clipCount,
      media_file_count: fileSampleRates.size,
      issues: Object.freeze(issues),
    });
  }
}
