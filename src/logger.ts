
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { ActionLog } from './types.js';

export class Logger {
  private logDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.logDir = path.join(baseDir, 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  log(data: ActionLog): string {
    const now = new Date();
    // JSTのオフセットは+9時間です。
    // date.toISOString() はUTCを返すため、手動でJSTに変換してフォーマットします。
    const toJST = (date: Date) => {
      // JSTに調整
      const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
      return jstDate.toISOString().replace('Z', '').replace('T', ' ');
    };

    const timestampJST = toJST(now);
    // data.timestamp が空、またはUTC形式(Zで終わる)の場合はJSTを設定
    if (!data.timestamp || data.timestamp.endsWith('Z')) {
      data.timestamp = timestampJST;
    }

    // ファイル名: YYYY-MM-DD HH-mm-SS-sss.yaml
    const filename = timestampJST.replace(/:/g, '-').replace('.', '-') + '.yaml';

    const filepath = path.join(this.logDir, filename);

    const logContent = yaml.stringify(data);

    // コンソールにも出力 (ユーザー要望)
    console.log("\n--- ログ出力 ---");
    console.log(logContent);
    console.log("----------------\n");

    fs.writeFileSync(filepath, logContent, 'utf8');

    return filepath;
  }

  getLastLog(): ActionLog | null {
    const files = fs.readdirSync(this.logDir).sort().reverse();
    if (files.length === 0) return null;

    const lastFile = files[0];
    const content = fs.readFileSync(path.join(this.logDir, lastFile), 'utf8');
    try {
      return yaml.parse(content) as ActionLog;
    } catch (e) {
      console.error("最後のログのパースに失敗しました:", e);
      return null;
    }
  }
}
