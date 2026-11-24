import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudioRouteUrl, parseStudioRoute } from './studioRouter';

test('parseStudioRoute handles default root and /projects', () => {
  assert.deepEqual(parseStudioRoute({ pathname: '/', search: '' }), {
    appView: 'projects',
    projectId: null,
    activeTab: 'studio',
    isLabMode: false,
  });

  assert.deepEqual(parseStudioRoute({ pathname: '/projects', search: '?mode=lab' }), {
    appView: 'projects',
    projectId: null,
    activeTab: 'studio',
    isLabMode: true,
  });
});

test('parseStudioRoute resolves /studio and /studio/:projectId plus legacy ?view=studio', () => {
  assert.deepEqual(parseStudioRoute({ pathname: '/studio', search: '' }), {
    appView: 'studio',
    projectId: null,
    activeTab: 'studio',
    isLabMode: false,
  });

  assert.deepEqual(parseStudioRoute({ pathname: '/studio/prj_123', search: '?mode=lab' }), {
    appView: 'studio',
    projectId: 'prj_123',
    activeTab: 'studio',
    isLabMode: true,
  });

  assert.deepEqual(parseStudioRoute({ pathname: '/', search: '?view=studio&project=prj_legacy' }), {
    appView: 'studio',
    projectId: 'prj_legacy',
    activeTab: 'studio',
    isLabMode: false,
  });
});

test('parseStudioRoute resolves /lab/shahab, /lab/graph, /lab/storage directly', () => {
  assert.deepEqual(parseStudioRoute({ pathname: '/lab/shahab', search: '' }), {
    appView: 'studio',
    projectId: null,
    activeTab: 'shahab',
    isLabMode: true,
  });

  assert.deepEqual(parseStudioRoute({ pathname: '/lab/graph', search: '?project=prj_9' }), {
    appView: 'studio',
    projectId: 'prj_9',
    activeTab: 'graph',
    isLabMode: true,
  });

  assert.deepEqual(parseStudioRoute({ pathname: '/lab/storage/', search: '' }), {
    appView: 'studio',
    projectId: null,
    activeTab: 'storage',
    isLabMode: true,
  });

  assert.deepEqual(parseStudioRoute({ pathname: '/', search: '?mode=lab&view=shahab' }), {
    appView: 'studio',
    projectId: null,
    activeTab: 'shahab',
    isLabMode: true,
  });
});

test('buildStudioRouteUrl produces clean path URLs while preserving lab mode', () => {
  assert.equal(
    buildStudioRouteUrl({ appView: 'studio', projectId: 'prj_abc' }, 'http://localhost:3000/projects'),
    '/studio/prj_abc',
  );

  assert.equal(
    buildStudioRouteUrl(
      { appView: 'studio', activeTab: 'shahab', projectId: 'prj_abc', preserveLabMode: true },
      'http://localhost:3000/studio/prj_abc?mode=lab',
    ),
    '/lab/shahab?mode=lab&project=prj_abc',
  );

  assert.equal(
    buildStudioRouteUrl(
      { appView: 'projects' },
      'http://localhost:3000/studio/prj_abc?mode=lab',
    ),
    '/projects?mode=lab',
  );
});
