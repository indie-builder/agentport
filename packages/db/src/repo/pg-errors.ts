export function isPgCode(err: unknown, code: string): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('errno' in cause && cause.errno === code) return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

export function isPgConstraint(err: unknown, codes: string[], constraint: string): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if ('errno' in cause && 'constraint' in cause) {
      const { errno, constraint: name } = cause;
      if (codes.some((code) => errno === code) && name === constraint) {
        return true;
      }
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}
