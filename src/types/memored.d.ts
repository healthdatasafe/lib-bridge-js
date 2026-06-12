declare module 'memored' {
  interface MemoredOptions {
    purgeInterval?: number;
    logger?: unknown;
  }
  function setup (options?: MemoredOptions): void;
  function store (key: string, value: unknown, callback: (err: Error | null, expirationTime?: number) => void): void;
  function store (key: string, value: unknown, ttl: number, callback: (err: Error | null, expirationTime?: number) => void): void;
  function read (key: string, callback: (err: Error | null, value?: unknown) => void): void;
  function remove (key: string, callback: (err?: Error | null) => void): void;
  function clean (callback: (err?: Error | null) => void): void;
  function size (callback: (err: Error | null, size?: number) => void): void;
}
