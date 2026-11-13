function filenameExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
}

export function middleTruncate(name: string, max = 24): string {
  if (name.length <= max) return name;
  const extension = filenameExtension(name);
  const suffix = extension ? `.${extension}` : '';
  const stem = suffix ? name.slice(0, -suffix.length) : name;
  const available = Math.max(1, max - suffix.length - 1);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${stem.slice(0, head)}…${tail ? stem.slice(-tail) : ''}${suffix}`;
}
