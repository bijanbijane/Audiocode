#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const root = process.cwd();
const builtinSet = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.join(root, filePath), 'utf8'));
}

function insideRoot(filePath) {
  const rel = path.relative(root, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function packageNameFromSpecifier(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveProject(projectName, configPath, entries, manifestPath, boundaryCheck) {
  const absoluteConfig = path.join(root, configPath);
  const configRead = ts.readConfigFile(absoluteConfig, ts.sys.readFile);
  if (configRead.error) {
    throw new Error(`${projectName}: unable to read ${configPath}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    configRead.config,
    ts.sys,
    path.dirname(absoluteConfig),
    { noEmit: true },
    absoluteConfig,
  );
  const absoluteEntries = entries.map((entry) => path.join(root, entry));
  const program = ts.createProgram({ rootNames: absoluteEntries, options: parsed.options });
  const manifest = readJson(manifestPath);
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  const sourceFiles = program.getSourceFiles()
    .filter((file) => !file.isDeclarationFile && insideRoot(file.fileName))
    .map((file) => path.relative(root, file.fileName).split(path.sep).join('/'))
    .sort();

  const imports = [];
  const nonLiteralDynamicImports = [];
  const seen = new Set();

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !insideRoot(source.fileName)) continue;
    const constants = new Map();
    const sourceName = path.relative(root, source.fileName).split(path.sep).join('/');

    function collectConstants(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        constants.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, collectConstants);
    }
    collectConstants(source);

    function addImport(specifier, kind) {
      if (!specifier || typeof specifier !== 'string') return;
      const key = `${sourceName}\u0000${kind}\u0000${specifier}`;
      if (seen.has(key)) return;
      seen.add(key);

      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) {
        const resolved = ts.resolveModuleName(specifier, source.fileName, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
        imports.push({
          from: sourceName,
          specifier,
          kind,
          resolved: resolved && insideRoot(resolved)
            ? path.relative(root, resolved).split(path.sep).join('/')
            : resolved ? path.relative(root, resolved).split(path.sep).join('/') : null,
          externalPackage: null,
        });
        return;
      }

      const packageName = packageNameFromSpecifier(specifier);
      if (builtinSet.has(specifier) || builtinSet.has(packageName)) return;

      const resolved = ts.resolveModuleName(specifier, source.fileName, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
      imports.push({
        from: sourceName,
        specifier,
        kind,
        resolved: resolved ? path.relative(root, resolved).split(path.sep).join('/') : null,
        externalPackage: packageName,
      });
    }

    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        addImport(node.moduleSpecifier.text, ts.isImportDeclaration(node) ? 'import' : 'export');
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        addImport(node.argument.literal.text, 'import-type');
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          addImport(argument.text, node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require');
        } else if (argument && ts.isIdentifier(argument) && constants.has(argument.text)) {
          addImport(constants.get(argument.text), 'dynamic-import-variable');
        } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          nonLiteralDynamicImports.push({ from: sourceName, expression: argument?.getText(source) ?? '(no argument)' });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  const externalPackages = [...new Set(imports.map((item) => item.externalPackage).filter(Boolean))].sort();
  const undeclaredPackages = externalPackages.filter((name) => !declared.has(name));
  const crossBoundaryImports = imports
    .filter((item) =>
      item.resolved &&
      !item.resolved.startsWith('node_modules/') &&
      !item.resolved.startsWith('..') &&
      boundaryCheck(item.from, item.resolved)
    )
    .map(({ from, specifier, resolved }) => ({ from, specifier, resolved }));

  return {
    project: projectName,
    entrypoints: entries,
    manifest: manifestPath,
    sourceFileCount: sourceFiles.length,
    sourceFiles,
    externalPackages,
    undeclaredPackages,
    unresolvedRelativeImports: imports
      .filter((item) => (item.specifier.startsWith('.') || item.specifier.startsWith('@/')) && !item.resolved)
      .map(({ from, specifier }) => ({ from, specifier })),
    crossBoundaryImports,
    nonLiteralDynamicImports,
  };
}

const results = [
  resolveProject(
    'web-ui',
    'tsconfig.json',
    ['src/main.tsx', 'vite.config.ts'],
    'package.json',
    (_from, to) =>
      to === 'server.ts' ||
      to.startsWith('server/') ||
      to.startsWith('backend/src/') ||
      to === 'src/platform/PlatformApiCompatibilityProxy.ts',
  ),
  resolveProject(
    'local-audio-runtime',
    'tsconfig.json',
    ['server.ts'],
    'package.json',
    (_from, to) =>
      to === 'src/main.tsx' ||
      to === 'src/App.tsx' ||
      to.startsWith('src/components/') ||
      to.startsWith('src/ui/'),
  ),
  resolveProject(
    'platform-api',
    'backend/tsconfig.json',
    ['backend/src/main.ts'],
    'backend/package.json',
    (_from, to) =>
      to.startsWith('src/') ||
      to.startsWith('packages/') ||
      to === 'server.ts',
  ),
];

const output = {
  generatedAt: new Date().toISOString(),
  note: 'Source-derived dependency report. It does not replace clean-lockfile builds or runtime tests.',
  projects: results,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
