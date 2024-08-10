// soul-engine.d.ts
declare module 'soul-engine/soul' {
    export class Soul {
      constructor(config: any);
      connect(): Promise<void>;
      on(event: string, callback: (data: any) => void): void;
      dispatch(action: any): void;
    }
  }
  