import { describe, expect, it } from 'vitest';
import { ALLOWED_MODEL_DOWNLOAD_HOSTS } from '../src/asr-core/SafeModelSupplyChain';
import {
  SHAHAB_KOOCHIK_MODEL_PROVENANCE,
  validateKoochikModelLicense,
} from '../src/asr-core/KoochikModelProvenance.mjs';

const apacheReadme = `---
license: apache-2.0
language: fa
library_name: sherpa-onnx
---
# Shenava Koochik v1.0
`;
const apacheLicense = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/LICENSE-2.0
TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION
`;

describe('pinned Koochik model provenance', () => {
  it('pins the model to the upstream commit that corrected license metadata', () => {
    expect(SHAHAB_KOOCHIK_MODEL_PROVENANCE.revision)
      .toBe('158e40e9ccf166c3655b7f4cd2abbfc7bbc87f7a');
    expect(SHAHAB_KOOCHIK_MODEL_PROVENANCE.licenseId).toBe('apache-2.0');
    expect(SHAHAB_KOOCHIK_MODEL_PROVENANCE.model.sha256)
      .toBe('6a564b5541920ce1c37bbc91d22e4b3a6838648b9b327eb88997e8db1f90950d');
  });

  it('uses only explicit official Hugging Face delivery hostnames', () => {
    for (const host of [
      'huggingface.co',
      'cas-server.xethub.hf.co',
      'cas-server.xethub-eu.hf.co',
      'transfer.xethub.hf.co',
      'transfer.xethub-eu.hf.co',
      'us.aws.cdn.hf.co',
      'us.gcp.cdn.hf.co',
      'cdn-lfs-us-1.hf.co',
      'cdn-lfs-eu-1.hf.co',
      'cas-bridge.xethub.hf.co',
    ]) {
      expect(ALLOWED_MODEL_DOWNLOAD_HOSTS).toContain(host);
    }
  });

  it('accepts matching Apache-2.0 model card metadata and license text', () => {
    expect(validateKoochikModelLicense(apacheReadme, apacheLicense)).toEqual({
      licenseId: 'apache-2.0',
      licenseName: 'Apache License 2.0',
    });
  });

  it('rejects the historical CC-BY-NC metadata revision', () => {
    const oldReadme = apacheReadme.replace('license: apache-2.0', 'license: cc-by-nc-4.0');
    expect(() => validateKoochikModelLicense(oldReadme, apacheLicense))
      .toThrow(/KOOCHIK_MODEL_LICENSE_METADATA_MISMATCH/);
  });

  it('rejects a missing or non-Apache license file', () => {
    expect(() => validateKoochikModelLicense(apacheReadme, ''))
      .toThrow(/KOOCHIK_MODEL_LICENSE_FILE_INVALID/);
  });

  it('rejects a missing model-card license declaration', () => {
    expect(() => validateKoochikModelLicense('---\nlanguage: fa\n---\nModel', apacheLicense))
      .toThrow(/KOOCHIK_MODEL_LICENSE_METADATA_MISMATCH/);
  });
});
