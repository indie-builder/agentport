function hasPgCause(err: unknown, match: (cause: object) => boolean): boolean {
  let cause: unknown = err;
  for (let depth = 0; depth < 5 && typeof cause === 'object' && cause !== null; depth += 1) {
    if (match(cause)) return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}

export function isPgCode(err: unknown, code: string): boolean {
  return hasPgCause(err, (cause) => 'errno' in cause && cause.errno === code);
}

export function isPgConstraint(err: unknown, codes: string[], constraint: string): boolean {
  return hasPgCause(
    err,
    (cause) =>
      'errno' in cause &&
      'constraint' in cause &&
      codes.some((code) => cause.errno === code) &&
      cause.constraint === constraint,
  );
}
