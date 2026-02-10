
export interface AIState {
  boredom: number;
  lastActionTimestamp: number;
  history: ActionLog[];
}

export interface ActionLog {
  timestamp: string;
  intent: string;
  action: string[];
  result: string[];
  next: string[];
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
