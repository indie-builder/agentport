export const resolveTmpDir = () => (Bun.env.TMPDIR || '/tmp').replace(/\/+$/, '');
