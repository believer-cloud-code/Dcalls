/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class CacheService {
  private static instance: CacheService;
  private prefix = 'dcalls_cache_';

  private constructor() {}

  public static getInstance(): CacheService {
    if (!CacheService.instance) {
      CacheService.instance = new CacheService();
    }
    return CacheService.instance;
  }

  public set(key: string, data: any): void {
    try {
      const serializedData = JSON.stringify({
        data,
        timestamp: Date.now()
      });
      localStorage.setItem(this.prefix + key, serializedData);
    } catch (error) {
      console.error('Error saving to cache:', error);
    }
  }

  public get(key: string, maxAgeMs?: number): any | null {
    try {
      const item = localStorage.getItem(this.prefix + key);
      if (!item) return null;

      const { data, timestamp } = JSON.parse(item);
      
      if (maxAgeMs && Date.now() - timestamp > maxAgeMs) {
        localStorage.removeItem(this.prefix + key);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error reading from cache:', error);
      return null;
    }
  }

  public remove(key: string): void {
    localStorage.removeItem(this.prefix + key);
  }

  public clear(): void {
    Object.keys(localStorage)
      .filter(key => key.startsWith(this.prefix))
      .forEach(key => localStorage.removeItem(key));
  }
}
