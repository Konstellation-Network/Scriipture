import { storage } from "scriipture";

export class BadBindings {
  @storage total: bigint = 0n;

  bad(): void {
    const [ok = true, ...rest] = (this as any).call("");
    const [[a, b], c]: [[bigint, bigint], bigint] = (this as any).nested();
  }
}
