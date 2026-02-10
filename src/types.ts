// 提案の種類
export type ProposalType =
  | 'CODE_EXECUTE'     // TypeScript コードの実行
  | 'SERVER_START'     // サーバ起動提案
  | 'INSTALL_PACKAGE'  // npm パッケージインストール提案
  | 'SELF_MODIFY'      // 自己コード変更提案
  | 'SHELL_COMMAND'    // 新しいシェルコマンド許可提案
  | 'OTHER';           // その他の提案

// 提案ログ
export interface Proposal {
  type: ProposalType;
  title: string;        // 提案のタイトル
  reasoning: string;    // 提案理由
  details: string;      // 詳細説明
  risks: string[];      // リスク評価
  benefits: string[];   // 期待される利益

  // `CODE_EXECUTE` の場合
  targetFile?: string;  // 実行するファイルパス (例 : `outputs/script.ts`)

  // HTTP リクエスト提案などで使う可能性のあるフィールド
  url?: string;
  method?: string;
  data?: any;
  command?: string;

  approved?: boolean;   // 承認状態
  timestamp: string;    // 提案日時
  id?: string;          // 提案 ID (ファイル名から生成)
}

export interface ActionLog {
  timestamp: string;
  intent: string;
  action: string;        // 人間向けの説明 (文字列1つ)
  result: string[];
  next: string[];
  proposal?: Proposal;   // 提案がある場合に記録
  responseRaw?: string;  // AI の生の出力 (デバッグ用)
}
