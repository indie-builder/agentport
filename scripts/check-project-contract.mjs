import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

if (process.argv[2] === '--rule-ids') {
  const ids = new Set();
  const dir = join(dirname(import.meta.path), 'contract');
  const files = [import.meta.path];
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (/^rules-.*\.ts$/.test(f)) files.push(join(dir, f));
  }
  for (const file of files) {
    const opts = { sourceType: 'module', plugins: ['typescript'] };
    traverse(parse(readFileSync(file, 'utf8'), opts), {
      'CallExpression|OptionalCallExpression'(p) {
        const {
          callee: c,
          arguments: [id],
          loc,
        } = p.node;
        const line = loc?.start.line ?? 0;
        if (c.name === 'report' || c.property?.name === 'report') {
          if (id?.type !== 'StringLiteral')
            throw new Error(`report 缺少静态规则 ID（第 ${line} 行）`);
          ids.add(id.value);
        } else if (c.object?.name === 'problems' && c.property?.name === 'push') {
          throw new Error(`请通过 report 添加诊断（第 ${line} 行）`);
        }
      },
    });
  }
  console.log(JSON.stringify([...ids].sort()));
  process.exit(0);
}
const { runContractCli } = await import('./contract/index.ts');
process.exit(runContractCli(process.argv.slice(2)));
