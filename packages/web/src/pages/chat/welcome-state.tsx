export function WelcomeState() {
  return (
    <div className="flex w-full flex-col gap-6 py-10 sm:py-12">
      <div className="flex flex-wrap items-center gap-4 sm:gap-5">
        <img
          src="/brand/pace-chat-woodworker.svg"
          alt=""
          aria-hidden="true"
          width={916}
          height={637}
          className="h-auto w-24 shrink-0 object-contain"
        />
        <h2 className="min-w-0 flex-1 text-2xl font-medium tracking-[-0.02em] text-fg">
          今天想完成什么？
        </h2>
      </div>
    </div>
  );
}
