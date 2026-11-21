# SHAHAB SDK Developer Guide

```ts
import { createShahabSdkEngine, SHAHAB_SDK_API_VERSION } from './src/shahab/sdk/ShahabSdk';

const sdk = createShahabSdkEngine({ modelDir: 'models/persian-zipformer-transducer/1.0.0' });
await sdk.initialize();
const grant = sdk.negotiateCapabilities({
  hostId: 'my-host',
  hostAdapterVersion: '1.0.0',
  requestedApiMajorVersion: 1,
  requestedExecutionMode: 'LOCAL',
  explicitCloudAuthorization: false,
});
```
