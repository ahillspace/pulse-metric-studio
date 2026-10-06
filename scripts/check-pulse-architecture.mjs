import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Check responsibility boundaries, independently of formatting or file size. */
export function inspectPulseBoundary(filename, source) {
  const file = filename.replaceAll('\\', '/');
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return [];
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const failures = [];
  const web = file.startsWith('packages/web/src/');
  const pulseServer = file.startsWith('packages/pulse/src/');
  const domain = file.startsWith('packages/shared/src/pulse-domain') || file.startsWith('packages/pulse/src/domain/');
  const application = file.startsWith('packages/pulse/src/application/');
  const report = (node, message) => {
    const line = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1;
    failures.push({ file, line, message });
  };
  function visit(node) {
    if ((web || pulseServer) && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || node.kind === ts.SyntaxKind.TemplateHead)) {
      if (/^\/api\/(drafts(?:\/|$)|pulse\/(metrics\/(create|fork-dimensional)(?:\/|$)|runs(?:\/|$)|fork(?:\/|$)))/.test(node.text)) {
        report(node, 'Retired Pulse mutation and persistence endpoints must not have production callers or routes.');
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const target = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (web && (/^@pulse-metric-studio\/(pulse|core|server)(\/|$)/.test(target) || /better-sqlite3|node:/.test(target))) report(node, 'Presentation cannot import server, SQLite, or Node capabilities.');
      if (pulseServer && (target.includes('/web/') || target.startsWith('@pulse-metric-studio/web'))) report(node, 'Pulse backend cannot depend on presentation.');
      if (domain && (/^(node:|react|fastify|better-sqlite3|@pulse-metric-studio\/core)/.test(target) || /\/(persistence|adapters|application)\//.test(target))) report(node, 'Pure Pulse domain rules cannot depend on IO or workflows.');
      if (application && /\bgetDb\b/.test(node.getText(syntax))) report(node, 'Application workflows must use repositories instead of opening SQLite.');
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if ((domain || application) && ts.isIdentifier(expression) && expression.text === 'fetch') report(node, 'Domain and application workflows must use an external adapter instead of fetch.');
      if (application && ts.isPropertyAccessExpression(expression) && expression.name.text === 'prepare'
        && expression.expression.kind !== ts.SyntaxKind.ThisKeyword) report(node, 'SQL belongs in a repository.');
      if (web && ts.isIdentifier(expression) && expression.text === 'buildCreatePayloads') report(node, 'The backend owns Tableau definition serialization.');
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  return failures;
}

export function checkPulseArchitecture(base = root) {
  const files = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(full);
    }
  };
  for (const area of ['packages/web/src', 'packages/pulse/src', 'packages/shared/src']) walk(path.join(base, area));
  return files.flatMap((file) => inspectPulseBoundary(path.relative(base, file), fs.readFileSync(file, 'utf8')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkPulseArchitecture();
  for (const failure of failures) console.error(`${failure.file}:${failure.line} ${failure.message}`);
  if (failures.length) process.exitCode = 1;
  else console.log('Pulse architecture boundaries passed.');
}
