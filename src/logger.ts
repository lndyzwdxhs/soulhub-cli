import fs from "node:fs";
import path from "node:path";

// 日志级别
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 日志保留天数
const LOG_RETENTION_DAYS = 7;

class Logger {
  private logDir: string;
  private verbose = false;
  private initialized = false;

  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    this.logDir = path.join(home, ".soulhub", "logs");
  }

  /**
   * 初始化日志系统
   * @param verbose 是否开启 debug 级别输出到终端
   */
  init(verbose = false): void {
    this.verbose = verbose;
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.initialized = true;
    // 异步清理旧日志，不阻塞主流程
    this.cleanOldLogs();
  }

  /**
   * 获取当前日志文件路径（按日期）
   */
  private getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return path.join(this.logDir, `soulhub-${date}.log`);
  }

  /**
   * 格式化日志行
   */
  private formatLine(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const levelTag = level.toUpperCase().padEnd(5);
    let line = `[${timestamp}] ${levelTag} ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      line += ` | ${JSON.stringify(meta)}`;
    }
    return line;
  }

  /**
   * 写入日志到文件
   */
  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    // 即使未初始化也尝试写入（容错）
    if (!this.initialized) {
      try {
        this.init(this.verbose);
      } catch {
        // 无法初始化日志目录，静默失败
        return;
      }
    }

    const line = this.formatLine(level, message, meta);

    // 写入文件
    try {
      fs.appendFileSync(this.getLogFilePath(), line + "\n");
    } catch {
      // 写入失败不应影响主流程
    }

    // verbose 模式下，debug 级别也输出到终端
    if (this.verbose && LEVEL_PRIORITY[level] === LEVEL_PRIORITY.debug) {
      console.log(`  ${line}`);
    }
  }

  /**
   * 清理超过保留天数的旧日志
   */
  private cleanOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = Date.now();
      const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.startsWith("soulhub-") || !file.endsWith(".log")) continue;

        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  // ==========================================
  // 公开的日志方法
  // ==========================================

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write("error", message, meta);
  }

  /**
   * 记录错误对象（自动提取 message 和 stack）
   */
  errorObj(message: string, err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.write("error", message, { error: errMsg, stack });
  }

  /**
   * 获取日志目录路径（供用户查看）
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * 获取今天的日志文件路径
   */
  getTodayLogFile(): string {
    return this.getLogFilePath();
  }
}

// 单例导出
export const logger = new Logger();
