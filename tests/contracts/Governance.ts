import { Address, storage, view, msg, Uint8, Uint64 } from "scriipture";

/// Lifecycle of a proposal.
export enum Status { Pending, Active, Executed }

/// One governance proposal record.
export interface Proposal {
  id: bigint;
  proposer: Address;
  votes: Uint64;
  status: Status;
}

export class Governance {
  @storage quorum: Uint8 = 51n as Uint8;
  @storage proposalCount: Uint64 = 0n as Uint64;
  @storage proposals: Map<bigint, Proposal> = new Map();
  @storage current: Status = Status.Pending;

  propose(): bigint {
    this.proposalCount = (this.proposalCount + 1n) as Uint64;
    const id: bigint = this.proposalCount;
    this.proposals.set(id, { id, proposer: msg.sender, votes: 0n as Uint64, status: Status.Pending });
    return id;
  }

  vote(id: bigint): void {
    const p = this.proposals.get(id)!;
    require(p.status === Status.Pending, "not pending");
    p.votes = (p.votes + 1n) as Uint64;
  }

  activate(id: bigint): void {
    this.proposals.get(id)!.status = Status.Active;
    this.current = Status.Active;
  }

  @view
  proposalOf(id: bigint): Proposal {
    return this.proposals.get(id)!;
  }

  @view
  quorumReached(id: bigint): boolean {
    const p = this.proposals.get(id)!;
    return p.votes >= this.quorum;
  }

  @view
  draft(id: bigint, proposer: Address): Proposal {
    return { id, proposer, votes: 0n as Uint64, status: Status.Pending };
  }
}
