/**
 * 进程级兜底。
 *
 * 请求内的异常由框架处理；这里管的是「没有请求上下文」的异常：
 * - unhandledRejection：某个忘了 catch 的 Promise
 * - uncaughtException：同步抛出的缺陷
 *
 * 两种都说明进程状态已不可信。做法是记录后退出，让编排器重启，
 * 而不是带着未知状态继续服务（Spring Boot 的默认行为也是退出）。
 * 退出前留一点时间让日志落盘，但不等待排空业务——那可能永远等不到。
 */
const EXIT_DELAY_MS = 100;

/** 只依赖 pino 的 log.error 形状，避免 core 为一个类型引入 pino 依赖。 */
type ErrorLogger = { error: (obj: unknown, msg?: string) => void };

export function installProcessGuards(logger: ErrorLogger): void {
  let exiting = false;

  const fatal = (kind: string, err: unknown): void => {
    logger.error({ err, kind }, 'fatal process error, exiting');
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(1), EXIT_DELAY_MS).unref();
  };

  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
  process.on('uncaughtException', (err) => fatal('uncaughtException', err));
}
