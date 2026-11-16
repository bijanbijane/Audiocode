import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EvaluationCorpusSampleEntry,
  PersianSpeechEvaluationCorpusBuilder,
} from './PersianSpeechEvaluationCorpusBuilder';

test('Section 90: PersianSpeechEvaluationCorpusBuilder verifies all mandatory Section 39 diversity axes and legal consent', () => {
  const fullCorpus: EvaluationCorpusSampleEntry[] = [
    {
      sampleId: 's1',
      legalLicenseSource: 'CC-BY-4.0 Studio Consent',
      speakerConsentVerified: true,
      style: 'FORMAL',
      accentOrDialectRegion: 'تهرانی',
      genre: 'LECTURE',
      speakingRate: 'SLOW',
      noiseTier: 'CLEAN_STUDIO',
      durationClass: 'SHORT_UNDER_3MIN',
      speakerCount: 1,
      containsStuttersAndFillers: false,
      containsLongPauses: true,
      containsEzafeChains: true,
      audioDurationSeconds: 150,
    },
    {
      sampleId: 's2',
      legalLicenseSource: 'Internal Licensed Corpus v1',
      speakerConsentVerified: true,
      style: 'COLLOQUIAL',
      accentOrDialectRegion: 'شیرازی',
      genre: 'PODCAST',
      speakingRate: 'FAST',
      noiseTier: 'MODERATE_ROOM_NOISE',
      durationClass: 'LONG_OVER_60MIN',
      speakerCount: 2,
      containsStuttersAndFillers: true,
      containsLongPauses: true,
      containsEzafeChains: true,
      audioDurationSeconds: 3800,
    },
    {
      sampleId: 's3',
      legalLicenseSource: 'Internal Licensed Corpus v1',
      speakerConsentVerified: true,
      style: 'MIXED_CODE_SWITCHING',
      accentOrDialectRegion: 'اصفهانی',
      genre: 'INTERVIEW',
      speakingRate: 'NORMAL',
      noiseTier: 'CHALLENGING_NOISE_50HZ',
      durationClass: 'MEDIUM_3_TO_30MIN',
      speakerCount: 3,
      containsStuttersAndFillers: true,
      containsLongPauses: false,
      containsEzafeChains: true,
      audioDurationSeconds: 900,
    },
    {
      sampleId: 's4',
      legalLicenseSource: 'Internal Licensed Corpus v1',
      speakerConsentVerified: true,
      style: 'FORMAL',
      accentOrDialectRegion: 'مشهدی',
      genre: 'EDUCATIONAL',
      speakingRate: 'NORMAL',
      noiseTier: 'CLEAN_STUDIO',
      durationClass: 'MEDIUM_3_TO_30MIN',
      speakerCount: 1,
      containsStuttersAndFillers: false,
      containsLongPauses: false,
      containsEzafeChains: true,
      audioDurationSeconds: 600,
    },
  ];

  const audit = PersianSpeechEvaluationCorpusBuilder.auditCorpusCoverageAndLegality(fullCorpus);
  assert.equal(audit.baselineReadyForThresholdApproval, true);
  assert.equal(audit.missingMandatoryAxes.length, 0);
  assert.equal(audit.distinctAccentsCount, 4);
});
