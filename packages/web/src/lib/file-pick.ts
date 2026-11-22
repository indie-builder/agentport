import type { ChangeEventHandler } from 'react';

export function onFilePick(
  handle: (files: FileList) => void,
): ChangeEventHandler<HTMLInputElement> {
  return (e) => {
    const files = e.currentTarget.files;
    if (files && files.length > 0) handle(files);
    e.currentTarget.value = '';
  };
}
