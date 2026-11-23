#!/usr/bin/env node
/**
 * Source-derived HTTP route and router-mount inventory.
 * This script does not declare a migration safe; it exposes route owners and
 * records whose request/auth/persistence contracts still need review.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '__tests__']);
const ROUTER_RECEIVER = /^(?:app|router|fastify|server|apiRouter|localRouter|httpRouter|expressApp|fastifyInstance|this\.(?:app|router|fastify|server))(?:\.[A-Za-z_$][\w$]*)*$/;

function walk(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) walk(path.join(directory, item.name), output);
      continue;
    }
    const extension = path.extname(item.name).toLowerCase();
    if (
      SOURCE_EXTENSIONS.has(extension) &&
      !/\.(?:test|spec|stories)\.[^.]+$/i.test(item.name) &&
      !item.endsWith('.d.ts')
    ) {
      output.push(path.join(directory, item.name));
    }
  }
  return output;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function getLiteralPath(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) {
    const paths = node.elements.map((item) => getLiteralPath(item));
    return paths.every((value) => value !== null) ? paths : null;
  }
  return null;
}

function unwrapReceiver(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const object = node.expression.expression;
    const method = node.expression.name.text;
    if (method === 'route' && node.arguments[0]) {
      return {
        receiver: object.getText(),
        routePath: getLiteralPath(node.arguments[0]),
      };
    }
  }
  return { receiver: node.getText(), routePath: null };
}

export function classifyRouteOwner(file, routePath) {
  if (file.startsWith('backend/src/')) return 'platform-api-fastify';
  if (file === 'server.ts') {
    const value = Array.isArray(routePath) ? routePath.join(' ') : (routePath ?? '');
    if (
      value === '/api/v1/crypto/public-key' ||
      value === '/api/v1/license/lease' ||
      value === '/api/v1/models/:modelId/manifest'
    ) return 'platform-api-hosted-compatibility-facade';

    if (value.startsWith('/v1/audio/transcriptions')) {
      return 'local-audio-product-boundary-review';
    }
    if (
      value.startsWith('/v1/models') ||
      value.startsWith('/v1/capabilities') ||
      value.startsWith('/v1/intelligence') ||
      value.startsWith('/v1/recordings') ||
      value.startsWith('/v1/integrations') ||
      value.startsWith('/v1/data') ||
      value.startsWith('/v1/datasets') ||
      value.startsWith('/api/v1/platform') ||
      value.startsWith('/api/v1/data-factory') ||
      value.startsWith('/api/v1/model-factory') ||
      value.startsWith('/api/v1/security')
    ) return 'platform-candidate-not-migrated';

    if (
      value.startsWith('/api/v2/companion') ||
      value.startsWith('/api/v2/smart-edit') ||
      value.startsWith('/api/shahab') ||
      value.startsWith('/api/local-auth') ||
      value.startsWith('/api/v1/asr') ||
      value.startsWith('/api/v1/asr-core') ||
      value.startsWith('/api/v1/processing') ||
      value.startsWith('/api/v1/streaming') ||
      value.startsWith('/api/v1/router') ||
      value.startsWith('/api/v1/lab') ||
      value.startsWith('/api/v1/engines') ||
      value.startsWith('/api/v1/benchmark') ||
      value.startsWith('/api/v1/continuous-learning') ||
      value.startsWith('/api/v1/local-models')
    ) return 'local-audio-runtime';

    return 'root-express-needs-review';
  }
  if (file.startsWith('src/platform/')) return 'platform-client-or-facade';
  if (
    file.startsWith('src/host-bridge/') ||
    file.startsWith('src/asr-core/') ||
    file.startsWith('src/processing-engine/') ||
    file.startsWith('src/workflow/') ||
    file.startsWith('src/shahab/') ||
    file.startsWith('src/lifecycle/')
  ) return 'local-audio-runtime-module';
  if (
    file.startsWith('src/data-factory/') ||
    file.startsWith('src/model-factory/') ||
    file.startsWith('src/intelligence/') ||
    file.startsWith('src/platform/')
  ) return 'platform-candidate-module';
  return 'source-route-needs-review';
}

export function scanSourceTree() {
  const inputFiles = [
    path.join(ROOT, 'server.ts'),
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'backend/src')),
    ...walk(path.join(ROOT, 'packages')),
  ].filter((value, index, array) => fs.existsSync(value) && array.indexOf(value) === index);

  const routes = [];
  const mounts = [];
  const dynamicRoutes = [];

  for (const absolutePath of inputFiles) {
    const sourceText = fs.readFileSync(absolutePath, 'utf8');
    const extension = path.extname(absolutePath).toLowerCase();
    const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX
      : extension === '.jsx' ? ts.ScriptKind.JSX
      : extension === '.js' ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
    const source = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
    const file = relative(absolutePath);

    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toLowerCase();
        const rawReceiver = unwrapReceiver(node.expression.expression);
        const receiver = rawReceiver.receiver.replace(/\s+/g, '');

        if (METHODS.has(method) && (ROUTER_RECEIVER.test(receiver) || rawReceiver.routePath !== null)) {
          const firstArgument = node.arguments[0];
          const routePath = rawReceiver.routePath ?? getLiteralPath(firstArgument);
          const handlerCount = rawReceiver.routePath !== null ? node.arguments.length : Math.max(0, node.arguments.length - 1);
          if (routePath === null) {
            dynamicRoutes.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              receiver,
              method,
              expression: node.getText(source).slice(0, 300),
            });
          } else {
            routes.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              receiver,
              method: method.toUpperCase(),
              path: routePath,
              handlerArgumentCount: handlerCount,
              owner: classifyRouteOwner(file, routePath),
            });
          }
        }

        if (method === 'use' && ROUTER_RECEIVER.test(receiver)) {
          const first = node.arguments[0];
          const mountPath = getLiteralPath(first);
          const remaining = node.arguments.slice(mountPath === null ? 0 : 1);
          const mountExpression = remaining.map((arg) => arg.getText(source)).join(', ');
          const isLikelyRouterMount = /Router|router|create[A-Za-z]+HttpRouter|createExpressRouter|createShahabHttpRouter/.test(mountExpression);
          if (mountPath !== null || isLikelyRouterMount) {
            mounts.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              receiver,
              mountPath: mountPath ?? '(unscoped middleware/router)',
              middlewareOrRouter: mountExpression.slice(0, 500),
              classification: mountPath === null
                ? 'unscoped-router-or-middleware'
                : classifyRouteOwner(file, mountPath),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  routes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  mounts.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  dynamicRoutes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const counts = {};
  for (const route of routes) counts[route.owner] = (counts[route.owner] ?? 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    sourceFilesScanned: inputFiles.length,
    note: 'Static source inventory only. Mounted-router internals, dynamic routes and auth/data contracts still require human review before migration.',
    directRoutes: routes,
    mounts,
    dynamicRoutes,
    countsByOwner: counts,
    totals: {
      directRoutes: routes.length,
      mounts: mounts.length,
      dynamicRoutes: dynamicRoutes.length,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = scanSourceTree();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
