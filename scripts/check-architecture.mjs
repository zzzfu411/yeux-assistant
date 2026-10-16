import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname, join } from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
async function collect(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) await collect(path);
    else if (/\.tsx?$/.test(path)) files.push(path);
  }
}
await collect(join(root, 'apps'));
await collect(join(root, 'packages'));
const known = new Set(files);
const errors = [],
  edges = new Map();
function targetOf(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const path = resolve(dirname(from), specifier);
  const stem = /\.[mc]?js$/.test(path) ? path.slice(0, -extname(path).length) : path;
  return [path, stem + '.ts', stem + '.tsx', join(stem, 'index.ts')].find((value) => known.has(value));
}
function allowed(from, to) {
  if (from.startsWith('apps/device-bridge/'))
    return to.startsWith('apps/device-bridge/') || to.startsWith('packages/contracts/');
  if (from.startsWith('apps/web/')) return to.startsWith('apps/web/') || to.startsWith('packages/contracts/');
  if (from.startsWith('packages/contracts/')) return to.startsWith('packages/contracts/');
  if (from.startsWith('packages/storage/')) return to.startsWith('packages/storage/');
  if (from.startsWith('packages/core/')) return !to.startsWith('apps/') && to !== 'packages/core/src/application.ts';
  return true;
}
for (const path of files) {
  const name = relative(root, path),
    source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const dependencies = [];
  function visit(node) {
    const reference =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          ? node.arguments[0]
          : null;
    if (reference && ts.isStringLiteral(reference)) {
      const target = targetOf(path, reference.text);
      if (target) {
        const destination = relative(root, target);
        if (!allowed(name, destination)) errors.push(`${name} must not depend on ${destination}`);
        const typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly ||
            (!node.importClause?.name &&
              node.importClause?.namedBindings &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.every((item) => item.isTypeOnly))
          : ts.isExportDeclaration(node) && node.isTypeOnly;
        if (!typeOnly) dependencies.push(destination);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  edges.set(name, dependencies);
}
const visited = new Set(),
  active = [];
function visit(name) {
  if (active.includes(name)) {
    errors.push('Runtime dependency cycle: ' + [...active.slice(active.indexOf(name)), name].join(' -> '));
    return;
  }
  if (visited.has(name)) return;
  active.push(name);
  for (const dependency of edges.get(name) || []) visit(dependency);
  active.pop();
  visited.add(name);
}
for (const name of edges.keys()) visit(name);
// Fixed advisory lock keys live in one registry, each used once; text-derived keys are hashed instead.
const registry = 'packages/storage/src/locks.ts';
const keys = [...(await readFile(join(root, registry), 'utf8')).matchAll(/:\s*(\d+),/g)].map((match) => match[1]);
for (const key of keys.filter((key, index) => keys.indexOf(key) !== index))
  errors.push(`${registry} assigns advisory lock ${key} more than once`);
for (const path of files) {
  const name = relative(root, path);
  if (name !== registry && /\b8473920\d\d\b/.test(await readFile(path, 'utf8')))
    errors.push(`${name} must take advisory lock keys from ${registry}`);
}
// Typed keys in app.settings go through packages/core/src/kv.ts; other modules must not write that table directly.
const kvModule = 'packages/core/src/kv.ts';
for (const path of files) {
  const name = relative(root, path);
  if (name === kvModule || !name.startsWith('packages/core/')) continue;
  if (/(INSERT INTO|UPDATE|DELETE FROM)\s+app\.settings\b/.test(await readFile(path, 'utf8')))
    errors.push(`${name} must write app.settings through ${kvModule}`);
}
if (errors.length) {
  console.error([...new Set(errors)].join('\n'));
  process.exitCode = 1;
} else console.log(`Architecture boundaries and runtime import cycles checked (${files.length} TypeScript files).`);
