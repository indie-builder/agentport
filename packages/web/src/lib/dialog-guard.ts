type DialogCloseDetails = { cancel: () => void };

export function guardedOpenChange(
  pending: boolean,
  close: () => void,
): (next: boolean, details: DialogCloseDetails) => void {
  return (next, details) => {
    if (pending) {
      details.cancel();
      return;
    }
    if (!next) close();
  };
}
