
import { GoogleGenerativeAI } from "@google/generative-ai";
import ollama from "ollama";
import dotenv from "dotenv";

dotenv.config();

export class LLMClient {
  private genAI: GoogleGenerativeAI;
  private ollamaModel: string;
  private geminiModel: string;

  constructor(apiKey: string | undefined, ollamaModel: string = "qwen2.5-coder:7b", geminiModel: string = "gemini-2.0-flash-exp") {
    if (!apiKey) {
      console.warn("GEMINI_API_KEY が提供されていません。Gemini の機能は無効化されるか失敗します。");
    }
    this.genAI = new GoogleGenerativeAI(apiKey || "");
    this.ollamaModel = ollamaModel;
    this.geminiModel = geminiModel;
  }

  async chatOllama(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      const response = await ollama.chat({
        model: this.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt || '' },
          { role: 'user', content: prompt }
        ],
        stream: false, // ストリーミングを明示的に無効化
        options: {
          num_ctx: 8192 // Increase context window to prevent truncation
        }
      });
      return response.message.content;
    } catch (error) {
      console.error("Ollama エラー:", error);
      return "";
    }
  }

  async chatGemini(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      const model = this.genAI.getGenerativeModel({
        model: this.geminiModel,
        systemInstruction: systemPrompt
      });

      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      console.error("Gemini エラー:", error);
      return "Gemini API の呼び出しエラー。";
    }
  }
}
