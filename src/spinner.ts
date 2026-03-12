import chalk from "chalk";

/**
 * 轻量级终端 spinner，替代 ora v8
 * 避免 ora v8 (ESM-only) 在 @yao-pkg/pkg 打包的 CJS 二进制中触发 Segfault
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL = 80;

export interface Spinner {
  text: string;
  start: (text?: string) => Spinner;
  stop: () => Spinner;
  succeed: (text?: string) => Spinner;
  fail: (text?: string) => Spinner;
  warn: (text?: string) => Spinner;
}

export function createSpinner(initialText: string = ""): Spinner {
  let _text = initialText;
  let _timer: ReturnType<typeof setInterval> | null = null;
  let _frameIndex = 0;

  function clearLine(): void {
    if (process.stderr.isTTY) {
      process.stderr.write("\r\x1b[K");
    }
  }

  function render(): void {
    if (!process.stderr.isTTY) return;
    const frame = chalk.cyan(SPINNER_FRAMES[_frameIndex]);
    clearLine();
    process.stderr.write(`${frame} ${_text}`);
    _frameIndex = (_frameIndex + 1) % SPINNER_FRAMES.length;
  }

  function stopTimer(): void {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    clearLine();
  }

  function printStatus(symbol: string, text: string): void {
    stopTimer();
    // 非 TTY 环境也输出结果行
    process.stderr.write(`${symbol} ${text}\n`);
  }

  const spinner: Spinner = {
    get text(): string {
      return _text;
    },
    set text(value: string) {
      _text = value;
    },

    start(text?: string): Spinner {
      if (text) _text = text;
      _frameIndex = 0;
      if (_timer) clearInterval(_timer);
      // 非 TTY 时不渲染动画，只在结果时输出
      if (process.stderr.isTTY) {
        render();
        _timer = setInterval(render, FRAME_INTERVAL);
      }
      return spinner;
    },

    stop(): Spinner {
      stopTimer();
      return spinner;
    },

    succeed(text?: string): Spinner {
      printStatus(chalk.green("✔"), text || _text);
      return spinner;
    },

    fail(text?: string): Spinner {
      printStatus(chalk.red("✖"), text || _text);
      return spinner;
    },

    warn(text?: string): Spinner {
      printStatus(chalk.yellow("⚠"), text || _text);
      return spinner;
    },
  };

  return spinner;
}
