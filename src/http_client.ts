
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

export interface HttpResponse {
  status: number;
  statusText: string;
  data: any;
  headers: any;
  url: string;
}

export class HttpClient {
  private requestCount: number = 0;
  private lastRequestTime: number = 0;
  private readonly MAX_REQUESTS_PER_MINUTE = 10; // レート制限

  /**
   * HTTP GET リクエストを実行
   */
  async get(url: string, options?: AxiosRequestConfig): Promise<HttpResponse> {
    return this.request('GET', url, options);
  }

  /**
   * HTTP POST リクエストを実行
   */
  async post(url: string, data?: any, options?: AxiosRequestConfig): Promise<HttpResponse> {
    return this.request('POST', url, { ...options, data });
  }

  /**
   * HTTP PUT リクエストを実行
   */
  async put(url: string, data?: any, options?: AxiosRequestConfig): Promise<HttpResponse> {
    return this.request('PUT', url, { ...options, data });
  }

  /**
   * HTTP DELETE リクエストを実行
   */
  async delete(url: string, options?: AxiosRequestConfig): Promise<HttpResponse> {
    return this.request('DELETE', url, options);
  }

  /**
   * 統一されたHTTPリクエスト実行メソッド
   */
  private async request(method: string, url: string, options?: AxiosRequestConfig): Promise<HttpResponse> {
    // レート制限チェック
    this.checkRateLimit();

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        ...options,
        timeout: 30000, // 30秒のタイムアウト
        maxRedirects: 5,
        validateStatus: (status) => status < 600, // すべてのHTTPステータスを許可（エラーハンドリングは呼び出し側で）
      };

      const response: AxiosResponse = await axios(config);

      // レート制限カウンタを更新
      this.requestCount++;
      this.lastRequestTime = Date.now();

      return {
        status: response.status,
        statusText: response.statusText,
        data: response.data,
        headers: response.headers,
        url: response.config.url || url,
      };
    } catch (error: any) {
      // エラーレスポンスでも情報を返す
      if (error.response) {
        return {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers,
          url: error.config?.url || url,
        };
      }

      // ネットワークエラーなど
      throw new Error(`HTTP リクエストエラー: ${error.message}`);
    }
  }

  /**
   * レート制限をチェック
   */
  private checkRateLimit(): void {
    const now = Date.now();
    const oneMinute = 60 * 1000;

    // 1分経過していればカウンタをリセット
    if (now - this.lastRequestTime > oneMinute) {
      this.requestCount = 0;
    }

    // レート制限超過チェック
    if (this.requestCount >= this.MAX_REQUESTS_PER_MINUTE) {
      throw new Error(`レート制限超過: 1分間に${this.MAX_REQUESTS_PER_MINUTE}リクエストまでです。しばらく待ってから再試行してください。`);
    }
  }

  /**
   * 現在のレート制限状態を取得
   */
  getRateLimitStatus(): { count: number; limit: number; resetIn: number } {
    const now = Date.now();
    const oneMinute = 60 * 1000;
    const resetIn = Math.max(0, oneMinute - (now - this.lastRequestTime));

    return {
      count: this.requestCount,
      limit: this.MAX_REQUESTS_PER_MINUTE,
      resetIn: Math.ceil(resetIn / 1000), // 秒単位
    };
  }
}
