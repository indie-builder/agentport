export function RequiredMark() {
  return (
    <>
      <span className="ml-0.5 text-danger" aria-hidden="true">
        *
      </span>
      <span className="sr-only">必填</span>
    </>
  );
}
