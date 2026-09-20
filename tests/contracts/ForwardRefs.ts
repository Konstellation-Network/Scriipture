import { storage, view } from "scriipture";

/** Every type this struct names is declared *after* it. */
export interface Proposal {
  id: bigint;
  meta: Meta;
  status: Status;
}

export interface Meta {
  title: string;
  votes: bigint;
}

export enum Status { Pending, Active, Closed }

export class Forward {
  @storage proposals: Map<bigint, Proposal> = new Map();

  open(id: bigint, title: string): void {
    this.proposals.set(id, { id, meta: { title, votes: 0n }, status: Status.Pending });
  }

  /** An untyped local built from a cast literal, with a nested literal inside it. */
  draft(id: bigint, title: string): Proposal {
    const p = { id, meta: { title, votes: 0n }, status: Status.Pending } as Proposal;
    return p;
  }

  /** An untyped local built from an own method that returns a struct. */
  copy(id: bigint): Proposal {
    const p = this.draft(id, "copy");
    return p;
  }

  @view
  titleOf(id: bigint): string {
    return this.proposals.get(id)!.meta.title;
  }
}
