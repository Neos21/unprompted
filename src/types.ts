
export interface AIState {
  boredom: number;
  lastActionTimestamp: number;
  history: ActionLog[];
}

// 提案の種類
export type ProposalType =
  | 'HTTP_REQUEST'      // HTTP リクエスト提案
  | 'SERVER_START'      // サーバ起動提案
  | 'INSTALL_PACKAGE'   // npm パッケージインストール提案
  | 'SELF_MODIFY'       // 自己コード変更提案
  | 'SHELL_COMMAND'     // 新しいシェルコマンド許可提案
  | 'OTHER';            // その他の提案

// 提案ログ
export interface Proposal {
  type: ProposalType;
  title: string;         // 提案のタイトル
  reasoning: string;     // 提案理由
  details: string;       // 詳細説明
  risks: string[];       // リスク評価
  benefits: string[];    // 期待される利益
  command?: string;      // 実行コマンド（該当する場合）
  url?: string;          // HTTP リクエストの URL（該当する場合）
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; // HTTP メソッド
  data?: any;            // HTTP リクエストのデータ
  approved?: boolean;    // 承認状態
  timestamp: string;     // 提案日時
  id?: string;           // 提案ID（ファイル名から生成）
}

export interface ActionLog {
  timestamp: string;
  intent: string;
  action: string[];
  result: string[];
  next: string[];
  proposal?: Proposal;   // 提案がある場合に記録
}

export interface LLMResponse {
  intent: string;
  action: string[]; // 実行するコマンド、または行動の説明
  result: string[]; // 自己評価
  next: string[]; // 次回の予定
}

export interface AgentConfig {
  ollamaModel: string;
  geminiModel: string;
  boredomThreshold: number;
  loopInterval: number; // ミリ秒
}
